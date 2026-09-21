# Incident: bills printing late / not at all (Sep 2026)

A field write-up of the investigation, root cause, and fix for the restaurant
where **bill receipts were slow (minutes) or didn't print at all**, while
**KOT/BOT slips printed fine**. Kept as a reference in case anything similar
recurs. Resolved 2026-09-21.

> TL;DR — Two bugs, one trigger.
> - **Trigger:** the print agent's connection to snackk dropped constantly
>   (flaky link; hundreds of reconnects/day), mostly silent "idle timeout" stalls.
> - **Bug 1 (snackk, the real cause of *lost* bills):** on disconnect the realtime
>   hub deleted the bill channel's replay buffer. The bill channel has a single
>   subscriber (the print agent), so every reconnect wiped the buffer and any
>   `bill.print` published during the gap was lost from the live stream.
> - **Bug 2 (agent, the cause of *delay* + 90 MB log):** on every reconnect the
>   agent re-read a 12-hour window of settled bills *before* draining the live
>   stream, so fresh bills waited behind the backlog and the log filled with
>   `→ duplicate` lines.
> - KOT/BOT were unaffected because they recover from a DB-backed **active board**,
>   not the hub buffer.

---

## Symptom

- Bills settled at the counter printed **minutes late**, or sometimes **not at all**.
- KOT (kitchen) and BOT (bar) slips printed normally.
- `out.log` had grown to ~90 MB, dominated by `bill … → duplicate` and
  `skipped duplicate key=bill:…@0`.
- `.queue` (pending jobs) was empty; `seen.json` was small/bounded.

It was **not** happening in the first days of operation — it grew in over ~2 weeks.

## Investigation & evidence

Ruled out the local/downstream side first:

- **`.queue\pending` empty + `printer offline/online` events = 0 + `attempts=1`
  on nearly all prints.** The agent→printer path was essentially flawless — no
  stuck jobs, no dead letters. So the bottleneck was **upstream** (getting bills
  from snackk), not the printer.
- **`out.log` size is a symptom, not a cause.** Append logging speed is
  independent of file size. ~half the lines were reconcile re-seed noise.
- **`seen.json` is bounded** to 10,000 keys — not a growth problem. The bills in
  it were bills that *had* printed.

Then the upstream evidence:

- **Disconnect reasons in the log:** ~2063 `idle timeout`, ~861 `connect timeout`,
  ~845 `fetch failed`. The link to snackk was very unstable — mostly **silent
  half-open stalls** (idle timeout = no bytes at all for 60s, not even the 25s
  heartbeat).
- **Disconnects/day climbed over time:** ~68/day at the start → 500+/day as the
  place got busier. A stable link early on masked the latent bug.
- **September bills:** only a handful got `→ queued` (first-time printed) per day
  in a busy restaurant; the rest of the log was the same ~7 already-printed bill
  IDs cycling as `→ duplicate` every ~90s (the reconcile re-seeding the 12h window).

## Root cause

### Trigger — an unstable agent↔snackk link
The agent holds one long-lived SSE connection per feed out to the snackk cloud.
On a flaky/NAT'd link (see [Why it degraded](#why-it-got-worse-over-time)) these
connections die constantly — usually **silently** (NAT/router idle-timeout, WiFi
power-save), so the agent only notices when its 60s idle watchdog fires.

### Bug 1 — snackk hub discarded the replay buffer (the *lost bills*)
`server/realtime/hub.ts` deleted a channel **and its 64-event replay buffer** the
instant its last subscriber left:

```ts
if (ch.subscribers.size === 0) this.channels.delete(key);
```

The bill/print channel (`print:<restaurantId>`, see `server/realtime/channels.ts`)
has **exactly one subscriber — the device-keyed print agent.** So every agent
reconnect drove `subscribers.size` to 0 and wiped the buffer. A `bill.print`
published during the gap (or fanned out to a half-open, since-dead sink just
before the drop was detected) was discarded **right before** the agent reconnected
to replay it via `Last-Event-ID`. Result: the bill was **lost from the live
stream**.

**Why KOT/BOT survived:** their recovery reads the DB-backed **active board**
(`/api/print/station/:station/active`), which is independent of the hub buffer —
a kitchen ticket sits on the board for minutes and reprints on the next reconnect
regardless. Bills are terminal (a settle fires once, nothing holds them), so their
only net was the buffer + a slow recovery poll.

### Bug 2 — agent re-seeded 12h before draining live (the *delay* + log bloat)
`src/inbound/snackk/subscribe.js` (`subscribeBills.connectOnce`) did
`await seedBills()` — re-read the **last-12h** settled-bill window — **before** it
began draining the live stream. In a busy service that's hundreds of bills, so a
freshly-settled bill on the wire waited out the whole re-check before it printed,
and every reconnect poured a `→ duplicate` line per backlog bill into the log.

## The fix (both shipped 2026-09-21, verified in production)

### Fix 1 — snackk: retain the replay buffer across a disconnect
Commit `6975c8e` (merged to `main` via `9a45c61`), `server/realtime/hub.ts`:
- Keep the channel + buffer on last-leave instead of deleting it.
- Reclaim it lazily via **idle pruning** once it has sat subscriber-less past
  `retentionMs` (default 15 min — far longer than the agent's ~30s reconnect
  backoff). Longer outages still fall back to the 12h DB recovery poll.
- 12 hub tests pass, including reconnect-after-disconnect replay and the
  half-open-reap case.

> Note: that commit rode in on `feat/walkin-bills`, which also carries the walk-in
> bills feature and **DB migrations 0036 + 0037**. Deploying `main` runs those too.

### Fix 2 — agent: drain live concurrently with the re-seed
Commit `5d33007`, `src/inbound/snackk/subscribe.js`:
- Kick `seedBills()` off **concurrently** and drain the live stream immediately;
  await recovery in `finally` so a reconnect never stacks two seeds.
- Safe because `service.print()` reserves the idempotency key synchronously, so a
  bill arriving on both paths is deduped, never printed twice.
- Only the bill feed changed — the station feed keeps its ordered seed (KOT before
  the void gate).

### What the fixes do (and don't)
- A bill settled **while connected** → prints immediately (always did).
- A bill settled **during a disconnect** → **no longer lost**; replays the instant
  the agent reconnects, with no 90s-poll wait.
- The remaining latency floor is the **reconnect time** (up to ~60s to detect a
  silent death + the reconnect itself) — a *network* property, not something the
  code can erase. Shrink it by stabilizing the link (see below).
- The `→ duplicate` log lines **still appear** (the 90s reconcile still re-checks
  the window); the fix stops them *delaying* live bills, it doesn't silence them.

## Deployment

The two fixes run on **two different machines**:

| Fix | Runs on | How to deploy |
|---|---|---|
| `hub.ts` (Fix 1) | snackk **cloud** | deploy snackk `main` (incl. migrations 0036/0037) |
| `subscribe.js` (Fix 2) | the **Windows box** (pm2 `print-agent`) | update the file + `pm2 restart print-agent` |

**Agent update without git** (the box has no git — copy the single file):
1. Copy `src/inbound/snackk/subscribe.js` onto the box, over
   `C:\Users\<YOU>\Desktop\printing_test-main\src\inbound\snackk\subscribe.js`
   (back up the old one first: `copy subscribe.js subscribe.js.bak`).
2. Verify in an **Administrator** cmd:
   ```cmd
   node --check src\inbound\snackk\subscribe.js
   findstr /C:"const recovering = seedBills" src\inbound\snackk\subscribe.js
   ```
3. `pm2 restart print-agent` (Administrator — pm2 runs under LocalSystem; see
   `docs/WINDOWS_PM2_SERVICE.md`). Do **not** `pm2 save` for a code-only change.
4. Rollback if needed: `copy /Y subscribe.js.bak subscribe.js` + restart.

## How to read the logs

| Log line | Meaning | Action |
|---|---|---|
| `→ duplicate` / `skipped duplicate` | already printed, re-checked by the 90s reconcile | ✅ normal, ignore |
| `→ queued` | a **new** bill accepted and sent to the printer | ✅ a receipt should print |
| `printed cashier#N … attempts=1` | physically printed on the first try | ✅ healthy |
| `→ error` | rejected (empty items, no printer configured, …) | ⚠️ investigate |

Verification that clinched it (2026-09-21): a fresh bill
`14655adc-b240-436c-8814-8bf45b9f7a88` → `queued`, then
`printed cashier#579 printer=counter attempts=1`.

## Why it got worse over time

The bug is latent — it only bites when a disconnect **overlaps** a bill settling.
Early on the link was stable, so bills almost always caught the live event. As the
restaurant got busier the link degraded (more WiFi congestion, NAT pressure) and
disconnects went from ~68/day to 500+/day, so the overlap became routine. The
agent's 12h re-seed then amplified each reconnect (slow + noisy). It was a
threshold effect, not a switch — which is why it felt sudden.

## Follow-ups / hardening

- **Network is the real trigger.** Move the print box from **WiFi to Ethernet**
  (dedicated, full-duplex, no radio power-save/roaming) and disable NIC power
  management (Device Manager → adapter → Power Management). Then confirm the drop
  rate falls: `pm2 logs print-agent --lines 2000 | findstr /C:"disconnected"`.
  If drops persist on Ethernet, the cause is upstream (router NAT idle-timeout /
  ISP) — next lever is the router/keepalive.
- **Push the branches:** `printing_test` → `origin/main`; snackk `main` →
  `origin/main` (remember migrations 0036/0037).
- **Log rotation** so `out.log` can't fill the disk (pm2-logrotate is installed;
  verify it's active).
- **Optional:** trim the reconcile cadence / 12h lookback to reduce the residual
  `→ duplicate` noise — lower priority now that it no longer delays live bills.
- **Do NOT** lower the client idle timeout (60s) alone — it's coupled to snackk's
  25s heartbeat (2.4×, tolerates one missed ping). If faster dead-link detection
  is ever needed, shorten the **heartbeat and idle timeout together** (e.g.
  10s/25s), a coordinated change on both sides.

## Related docs
- `docs/SNACKK_INTEGRATION.md` — how the agent wires to snackk over outbound SSE.
- `docs/WINDOWS_PM2_SERVICE.md` — running/restarting the agent as a boot service.
- `docs/PRINTER_SETUP_GUIDE.md` — the printer + network setup.
