# Snackk × print-agent — Operations & Testing Guide

Everything you need to install, configure, run, and **verify** thermal printing
(KOT / BOT / customer bills) for a restaurant running **snackk** — end to end,
from the POS-8360 on the shop LAN to the snackk cloud, including the network
failure drills that prove it survives real-world outages.

This guide lives in the **print-agent** repo (`~/Desktop/printing_test`) because
that is the piece you operate on-site. Its companion — the snackk *cloud* side
(feature model, endpoints, deploy) — is `docs/THERMAL_PRINTING.md` in the
**snackk** repo (`github.com/rii98/snackk`).

> **Read me first if you only have five minutes:** jump to
> [§7 Quick E2E on local Docker](#7-end-to-end-on-local-docker-the-happy-path).

---

## Table of contents

1. [What this is (architecture)](#1-what-this-is-architecture)
2. [Prerequisites](#2-prerequisites)
3. [Part A — Printer setup (POS-8360)](#3-part-a--printer-setup-pos-8360)
4. [Part B — The print-agent: install & configure](#4-part-b--the-print-agent-install--configure)
5. [Part C — Running the agent](#5-part-c--running-the-agent)
6. [Part D — The `/health` endpoint (your dashboard)](#6-part-d--the-health-endpoint-your-dashboard)
7. [End-to-end on **local Docker** (the happy path)](#7-end-to-end-on-local-docker-the-happy-path)
8. [End-to-end on **Render** (cloud → NAT)](#8-end-to-end-on-render-cloud--nat)
9. [Part F — Testing & verification](#9-part-f--testing--verification)
   - [F1 Automated tests](#f1-automated-tests)
   - [F2 Manual functional checks](#f2-manual-functional-checks)
   - [F3 Reliability & network-failure drills](#f3-reliability--network-failure-drills)
10. [Part G — Troubleshooting](#10-part-g--troubleshooting)
11. [Part H — Reliability design reference](#11-part-h--reliability-design-reference)
12. [Appendix — env vars, endpoints, cheat-sheet](#12-appendix)

---

## 1. What this is (architecture)

A restaurant's printer sits on a **private LAN behind NAT**. snackk runs in the
**cloud**. The cloud cannot open a connection *into* the shop, so the agent runs
**inside the shop** and reaches **out**:

```
   ┌─────────────────────────── shop LAN (behind NAT) ───────────────────────────┐
   │                                                                              │
   │   ┌───────────────┐   outbound HTTPS/SSE    ┌──────────────────────────┐     │
   │   │  print-agent   │ ──────────────────────▶ │  snackk (cloud)          │     │
   │   │  (this repo)   │ ◀────────────────────── │  Render / VPS + Postgres │     │
   │   └──────┬────────┘   KOT/BOT/bill events    └──────────────────────────┘     │
   │          │ ESC/POS over TCP :9100                                             │
   │          ▼                                                                    │
   │   ┌───────────────┐                                                           │
   │   │  POS-8360      │  80mm thermal printer @ 192.168.18.240:9100              │
   │   └───────────────┘                                                           │
   └──────────────────────────────────────────────────────────────────────────────┘
```

**Two repos, one system:**

| Repo | Role | Runs |
|------|------|------|
| `printing_test` (this) | On-prem **print-agent**: subscribes to snackk over SSE, maps events → tickets, prints ESC/POS. | On a small always-on box in the shop (Mac/Pi) |
| `snackk` | The restaurant app: orders, KDS, billing. Emits the print events + serves the device-authed endpoints. | Cloud (Render / VPS) + Postgres |

**Data flow (per order):**

1. A guest submits an order in snackk. In `direct` routing it is immediately
   `received` at its station (kitchen/bar).
2. snackk publishes a `ticket.new` on the station SSE channel.
3. The agent (subscribed outbound) receives it, maps it to a neutral **Ticket**,
   and prints a **KOT** (kitchen) or **BOT** (bar).
4. On **settle**, snackk emits a `bill.print`; the agent prints the **customer
   bill** with the exact figures the counter tendered.

**Why it survives outages** (the whole point of the reliability work): a
long-lived SSE link over NAT can die *silently* (wifi sleep, ISP reset, NAT idle
timeout) with no TCP FIN. The agent guards every stream with an **idle
watchdog**, reconnects with backoff, **re-seeds** the current board on every
reconnect, and runs a **periodic reconcile** — so a missed KOT self-heals and a
replayed one never double-prints. **Settled bills and VOID slips** that happened
while the agent was offline are recovered the same way, from their own snapshot
endpoints ([§11.7](#117-recovery-of-settled-bills--void-slips-offlinerestart)).
See [§11](#11-part-h--reliability-design-reference).

---

## 2. Prerequisites

| Need | Detail |
|------|--------|
| **Node.js 22+** | The agent uses `node --test`, `fetch`, `AbortSignal.timeout`. Check: `node -v`. |
| **The printer** | POS-8360 / "80-V", EPSON ESC/POS, 80mm (48 chars / 576 dots), has a cutter. |
| **Shop network** | Router on `192.168.18.x`. Printer at a **static** `192.168.18.240:9100`. |
| **snackk reachable** | Either local Docker (`http://localhost:3000`) or a cloud URL (`https://…onrender.com`). |
| **A device key** | Minted in snackk once printing is enabled — `snkp_…`. See the snackk repo's `docs/THERMAL_PRINTING.md`. |
| **Timezone** ⚠️ | The always-on box **must** be `Asia/Kathmandu` (UTC+5:45) or every bill's printed time is wrong. Check: `date`. |

Install the agent:

```bash
cd ~/Desktop/printing_test
npm install          # only 'express' + dev deps; the core is zero-dep
node --test          # 137 tests should pass
```

---

## 3. Part A — Printer setup (POS-8360)

### 3.1 Give the printer a static IP

The printer ships with a factory static IP (often `192.168.1.100`) that does not
match the shop subnet, so it is unreachable until reconfigured.

1. Temporarily put a laptop on the printer's factory subnet (or connect directly)
   and open its web config at `http://<printer-ip>/`.
   - Its HTTP server speaks **HTTP/0.9**, so `curl` needs `--http0.9`.
2. Set: **IP `192.168.18.240`**, subnet `255.255.255.0`, gateway `192.168.18.1`,
   **DHCP disabled**. `.240` is high to stay outside the router's DHCP pool.
3. The config form POSTs to `config.cgi` (fields `ip`/`sub`/`gw`/`mac`).
4. Reboot the printer; confirm it now answers on the shop LAN.

### 3.2 Verify reachability

```bash
# TCP connect to the raw-print port (should say "succeeded")
nc -z -G 2 192.168.18.240 9100 && echo OPEN || echo unreachable

# Optional: confirm it's the right box by MAC (from the ARP table after a probe)
arp -n 192.168.18.240
```

### 3.3 Print a real slip without snackk (fastest sanity check)

The agent ships offline verification tools (no snackk needed):

```bash
npm run verify cuts        # prints test slips and checks the CUT behaviour
```

> **The cut fix (important history):** early slips bled their tail onto the next
> slip because the cutter used `GS V 0` + a manual feed that landed the last line
> *at the blade*. It now uses **`GS V 66`** (cut function B — the printer feeds to
> its own cutting position, then cuts), so every slip is self-contained. If you
> ever see tails-on-next-slip again, the culprit is the cut command, not the feed.
> `cutFeed` is now just cosmetic bottom margin.

See [`VERIFY.md`](../VERIFY.md) for the full hands-on printer verification suite.

---

## 4. Part B — The print-agent: install & configure

### 4.1 The single-printer, multi-station model

This shop has **one** POS-8360 that serves cashier **and** kitchen **and** bar. A
ticket's `station` routes it to a printer; one printer may serve several
stations. Mapping all three to the one device means **one queue** feeds the
printer's single `:9100` socket — no three queues fighting over one connection.

The default config (`config.js`) already encodes this:

```jsonc
printers: {
  pos: {
    stations: ["cashier", "kitchen", "bar"],   // one device, three stations
    host: "192.168.18.240",
    mac:  "02:1f:e0:13:19:28",                 // fallback discovery if the IP moves
    port: 9100, width: 48, encoding: "latin1",
    cut: true, cutFeed: 7
  }
}
```

To override per-site without editing code, drop a `printers.json` in the repo
root (git-ignorable). It deep-merges over the defaults:

```jsonc
// printers.json — a second physical printer example
{
  "printers": {
    "pos":     { "stations": ["cashier"], "host": "192.168.18.240" },
    "kitchen": { "stations": ["kitchen", "bar"], "mac": "aa:bb:cc:dd:ee:ff", "width": 48 }
  }
}
```

### 4.2 Configuration layers (most specific wins)

1. **Defaults** in `src/config.js`
2. **`printers.json`** in the repo root
3. **Environment variables** (`PRINT_*`, `SNACKK_*`)

### 4.3 Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `SNACKK_URL` | *(unset)* | snackk base URL. **Enables the integration** when set with the key. No trailing slash needed (stripped). |
| `SNACKK_DEVICE_KEY` | *(unset)* | The `snkp_…` device key minted in snackk. |
| `SNACKK_STATIONS` | `kitchen,bar` | Comma-list of station channels to subscribe. (Bills ride a separate feed automatically.) |
| `PRINT_HTTP_PORT` | `4000` | Local HTTP inbound + `/health` port. |
| `PRINT_STORE_DIR` | `./.queue` | Durable queue + idempotency dir. Set to `memory` for a stateless run. |
| `PRINT_DISCOVERY` | `on` | `off` skips MAC discovery and uses the configured host directly. |
| `PRINT_API_KEY` | *(none)* | Shared secret guarding `POST /print`. Unset = open on the LAN (dev). |
| `PRINT_SHOP_NAME` | `NAMASTE MINI MARKET` | Branding header on slips. |
| `PRINT_SUBNET` | *(auto)* | Override the subnet scanned during MAC discovery. |
| `PRINT_SHUTDOWN_GRACE_MS` | `10000` | Max drain time for in-flight prints on shutdown. |

> **Golden rule:** the snackk integration is **opt-in and off by default**. With
> `SNACKK_URL`/`SNACKK_DEVICE_KEY` unset, the agent is just a local HTTP print
> server and never touches the cloud.

---

## 5. Part C — Running the agent

### 5.1 Standalone (local HTTP only, no snackk)

```bash
npm start
# → listens on :4000, POST a Ticket to http://<lan-ip>:4000/print
```

### 5.2 Against **local Docker** snackk

```bash
SNACKK_URL=http://localhost:3000 \
SNACKK_DEVICE_KEY=snkp_xxxxxxxx \
PRINT_HTTP_PORT=4010 \
PRINT_DISCOVERY=off \
PRINT_STORE_DIR=/tmp/agent-queue \
node src/index.js
```

### 5.3 Against **Render** (production cloud → your shop)

```bash
SNACKK_URL=https://snackk.onrender.com \
SNACKK_DEVICE_KEY=snkp_xxxxxxxx \
PRINT_HTTP_PORT=4010 \
PRINT_DISCOVERY=off \
node src/index.js
```

> Run the agent **natively** on the box (not containerized) so it can reach both
> the LAN printer and snackk. Point it at **plain http** for local Docker (not the
> Caddy `tls internal` proxy); use the real **https** URL for Render.

### 5.4 Always-on (production)

Use a process manager so it restarts on crash/reboot. Example with **pm2**:

```bash
npm i -g pm2
SNACKK_URL=https://snackk.onrender.com SNACKK_DEVICE_KEY=snkp_xxx \
  pm2 start src/index.js --name print-agent --time
pm2 save && pm2 startup     # survive reboots
```

**Set the box timezone** (bills print `closedAt` in the host TZ):

```bash
sudo timedatectl set-timezone Asia/Kathmandu   # Linux/Pi
# macOS: sudo systemsetup -settimezone Asia/Kathmandu
```

---

## 6. Part D — The `/health` endpoint (your dashboard)

`GET http://localhost:4010/health` is how you know the agent is alive **and**
actually subscribed to snackk. Sample:

```jsonc
{
  "ok": true,
  "shop": "NAMASTE MINI MARKET",
  "printers": {
    "pos": { "healthy": true, "depth": 0, "transport": "tcp://192.168.18.240:9100" }
  },
  "snackk": {
    "enabled": true,
    "state": "running",              // starting | awaiting-config | running | off
    "url": "https://snackk.onrender.com",
    "config": { "stationDelivery": "both", "orderRoutingMode": "direct" },
    "connected": 3,                  // feeds currently connected (of 3)
    "feeds": [
      { "station": "kitchen", "connected": true, "lastEventId": "42",
        "idleForMs": 9840, "seeds": 7, "connects": 4, "lastError": null },
      { "station": "bar",     "connected": true, "idleForMs": 9370, "seeds": 7, "connects": 4 },
      { "station": "bills",   "connected": true, "idleForMs": 9847, "connects": 4 }
    ]
  }
}
```

**Field reference:**

| Field | Meaning | What "good" looks like |
|-------|---------|------------------------|
| `printers.pos.healthy` | Printer queue is not in a failed state. | `true` |
| `printers.pos.depth` | Jobs waiting in the queue. | `0` at rest (spikes then drains) |
| `snackk.state` | Agent lifecycle. `awaiting-config` = up but snackk's config not fetched yet. | `running` |
| `snackk.connected` | How many of the 3 feeds are live. | `3` |
| `feeds[].idleForMs` | Milliseconds since the last byte (event **or** heartbeat). | **oscillates < 60000** (see below) |
| `feeds[].seeds` | Times this station re-seeded the board (connect + reconcile). | grows slowly |
| `feeds[].connects` | Times this feed (re)connected. | grows on each reconnect |
| `feeds[].lastError` | Last disconnect reason (stale after recovery). | `null` or a past reason |

> **The heartbeat sawtooth:** snackk sends `: ping` every **25s**. So a healthy
> `idleForMs` climbs toward ~25000 then resets — a sawtooth that **never reaches
> 60000**. If it climbs past 60000, the **idle watchdog** fires, aborts the dead
> socket, and reconnects. Watching this number is how you *see* the watchdog work
> ([§F3-2](#f3-2--idle-watchdog--silent-drop-wifi-off--the-headline-test)).

---

## 7. End-to-end on **local Docker** (the happy path)

The safest first run: a self-contained snackk (its own Postgres, migrations
auto-apply) with a seeded demo restaurant. Fully isolated from any real data.

### Step 1 — Bring up snackk

```bash
cd ~/Downloads/snackk
# `-f` overrides the .env's COMPOSE_FILE; DB_PORT dodges a local Postgres on 5432
env -u COMPOSE_FILE APP_PORT=3000 DB_PORT=5433 \
  docker compose -f docker-compose.local.yml up --build -d

# wait for healthy, then confirm:
curl -s http://localhost:3000/api/health          # {"ok":true,"db":"up"}
```

### Step 2 — Seed a demo restaurant

`scripts/seed-demo.ts` creates **Demo Bistro** (owner `owner@demo.test` /
`demo12345`), table **T1**, a **kitchen** item (Buff Momo) and a **bar** item
(Sweet Lassi) so one order splits into a KOT + a BOT.

```bash
# The container Postgres creds come from .env (NOT the compose fallback):
export $(grep -E '^POSTGRES_(USER|PASSWORD|DB)=' .env | xargs)
DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:5433/${POSTGRES_DB}" \
  npx tsx scripts/seed-demo.ts
# → prints restaurantId, qrToken, item ids, ownerLogin
```

> ⚠️ **Gotcha we hit:** the container's Postgres uses the `POSTGRES_*` values from
> snackk's `.env` (compose interpolation), *not* the `snackk_dev` fallback in the
> compose file. Read them from `.env` as above or the seed will fail with
> `28P01 password authentication failed`.

### Step 3 — Enable printing + mint the device key

```bash
BASE=http://localhost:3000 ; JAR=$(mktemp)
# owner login
curl -s -c "$JAR" -X POST $BASE/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"owner@demo.test","password":"demo12345"}' >/dev/null
# turn printing on (both = KDS + paper)
curl -s -b "$JAR" -X POST $BASE/api/settings/printing/enable \
  -H 'Content-Type: application/json' -d '{"stationDelivery":"both"}'
# mint the agent key (shown ONCE)
curl -s -b "$JAR" -X POST $BASE/api/settings/printer-device -d '{}'
# → {"token":"snkp_..."}
```

*(Or do it in the UI: **Settings → Printing** → enable → copy the key. See the
snackk guide's §4 "Enabling printing".)*

### Step 4 — Run the agent (§5.2) and confirm it subscribed

```bash
curl -s http://localhost:4010/health | python3 -m json.tool
# expect snackk.connected == 3, each feed connected:true, seeds >= 1
```

### Step 5 — Place an order → KOT + BOT print

```bash
BASE=http://localhost:3000
QR=<qrToken from seed> ; MOMO=<momo id> ; LASSI=<lassi id>
# scan the table → guest token
TOKEN=$(curl -s -X POST $BASE/api/tables/scan -H 'Content-Type: application/json' \
  -d "{\"restaurant\":\"demo\",\"qrToken\":\"$QR\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
# submit a round that splits kitchen + bar
curl -s -X POST $BASE/api/guest/orders -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"lines\":[{\"itemId\":\"$MOMO\",\"quantity\":2},{\"itemId\":\"$LASSI\",\"quantity\":1}]}"
```

**Expect:** a **KOT** (2× Buff Momo) and a **BOT** (1× Sweet Lassi) come out of the
printer. The agent log shows `→ queued (fire)` for each; `/health` shows
`depth 0, healthy true`.

### Step 6 — Settle → the bill prints

```bash
SID=<sessionId from the order response> ; JAR=$(mktemp)
curl -s -c "$JAR" -X POST $BASE/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"owner@demo.test","password":"demo12345"}' >/dev/null
curl -s -b "$JAR" -X POST $BASE/api/billing/sessions/$SID/settle \
  -H 'Content-Type: application/json' -d '{}'
```

**Expect:** a **customer bill** prints with subtotal / service / VAT / total that
**exactly match** the settle response. (The agent re-renders snackk's `रू`
display strings as ASCII `Rs`, but the numbers are passed through verbatim — see
[§F2](#f2-manual-functional-checks) and [§11.5](#115-money-passthrough-5).)

### Tear down

```bash
env -u COMPOSE_FILE docker compose -f docker-compose.local.yml down       # keep DB
env -u COMPOSE_FILE docker compose -f docker-compose.local.yml down -v    # wipe DB
```

---

## 8. End-to-end on **Render** (cloud → NAT)

This is the *real* rehearsal: outbound SSE from your shop to the cloud, over
actual NAT. It requires the `feat/thermal-printing` branch to be **running on
Render** and a **test restaurant** on the connected DB.

> ⚠️ **Production caution:** the Render service serves real restaurants off the
> shared Neon DB. The feature is **off by default**, so deploying the branch is a
> behavioural no-op for real tenants — but test orders write real (cleanable)
> rows. Use a clearly-marked test restaurant and clean it up after.

### Step 1 — Deploy the branch (Render dashboard)

1. Push the branch: `git push origin feat/thermal-printing`.
2. Render → the snackk web service → **Settings → Build & Deploy → Branch** →
   set to `feat/thermal-printing` → **Manual Deploy → Deploy latest commit**.
3. Confirm it's live **and running the branch**:
   ```bash
   curl -s https://snackk.onrender.com/api/health           # {"ok":true,"db":"up"}
   curl -so /dev/null -w '%{http_code}\n' \
     https://snackk.onrender.com/api/print/config            # 401 = branch live; 404 = still main
   ```
   A **401** (auth required) means the print endpoints exist. A **404** means
   Render is still serving `main` — the deploy hasn't taken.

### Step 2 — Seed a marked test restaurant on the prod DB

Use a **scoped** seed with a distinct slug so it can never touch real tenants
(the delete is `WHERE slug = 'print-rehearsal'` only):

```bash
cd ~/Downloads/snackk
node --env-file=.env.test --import tsx scripts/seed-rehearsal.ts
# → owner@print-rehearsal.test / rehearsal12345, qrToken, item ids
```

*(`.env.test` holds the Neon URL the Render deploy uses. Run **only** targeted,
self-cleaning scripts against it — never the full test suite.)*

### Step 3 — Enable + mint over the Render API, then run the agent

Identical to §7 steps 3–6, but with `BASE=https://snackk.onrender.com` and the
rehearsal restaurant's slug/creds. Point the agent at the Render URL (§5.3). On
`/health` you should see `snackk.url` = the Render URL and `connected: 3`.

### Step 4 — Clean up

- Render dashboard: switch **Branch back to `main`** → redeploy.
- Delete the test tenant: re-run the scoped delete, or
  `node --env-file=.env.test --import tsx -e "…delete where slug='print-rehearsal'…"`.
- Remove the scratch seed file if you added one (`scripts/seed-rehearsal.ts`).

---

## 9. Part F — Testing & verification

Three layers, cheapest first: **automated** → **manual functional** →
**reliability drills**. The drills in [§F3](#f3-reliability--network-failure-drills)
are the ones that matter for a print system, because a missed KOT is an angry
kitchen and a double bill is an angry guest.

### F1 Automated tests

| Command | Where | Covers |
|---------|-------|--------|
| `node --test` | agent | **148 tests** — ESC/POS encoding, cut bytes, queue durability/retry/dead-letter, idempotency (incl. durable `has()` across restart), the SSE parser, the snackk mapper & print-decision policy, **bill & VOID recovery seeds**, **the idle watchdog, connect timeout, reconcile, and `/health` status**. |
| `node --test test/snackk-subscribe.test.js` | agent | Just the SSE subscriber: watchdog reconnect, connect-timeout reconnect, reconcile-prints-a-missed-KOT, **bill/VOID recovery on connect**, `status()` shape. |
| `npx vitest run` | snackk | Full unit suite (DB-gated tests self-skip without a DB). |
| `npm run lint` | snackk | `tsc --noEmit` typecheck. |
| `npx vite build` | snackk | Frontend build. |
| `node --env-file=.env.test ./node_modules/.bin/vitest run tests/print.test.ts` | snackk | **DB-gated** print tests vs Neon (28): config lifecycle, device-auth, SSE delivery, enable/re-enable, bill emit gating. **Targeted + self-cleaning — safe against the shared DB.** |

> ⚠️ **Never run the full snackk suite against `.env.test`** — that DB is shared
> with the Render deploy (~21 real restaurants). Only the targeted, self-cleaning
> `print.test.ts` is safe there.

### F2 Manual functional checks

After a happy-path run (§7), verify by eye:

| Check | How | Pass |
|-------|-----|------|
| **KOT/BOT split** | One order with a kitchen + a bar item. | Two separate slips, correct station header. |
| **Quantities & names** | Order 2× / 3× of items. | Slip shows `2 × Buff Momo`, etc. |
| **Bill math** | Compare the printed bill to the settle response / counter screen. | subtotal / service / VAT / total **match exactly**. |
| **Money formatting** | Settle a bill over Rs 1,000. | Printed total is ASCII `Rs 1,951.51` (not `रू`, not mojibake). |
| **Cut** | Any slip. | Each slip is self-contained; no tail on the next slip. |
| **Void** | Void an order that already fired. | A **VOID** slip prints. Void one that never fired → no slip. |
| **KDS coexistence** | With `stationDelivery: both`. | The KDS board **and** the printer both get the ticket. |

> **Devanagari menu (#9) — not yet covered.** All the above used ASCII item names.
> Real Nepali items (देवनागरी) will **mojibake** on the latin1 codepage. Before
> production, decide: romanize the item names, transliterate, or switch the
> printer codepage. Currency is already handled (re-rendered as ASCII `Rs`).

### F3 Reliability & network-failure drills

Each drill: **why**, **do**, **expect**, **pass**. Run them with the agent live
against a snackk instance and `/health` open in another terminal.

#### F3-1 — Boot resilience (snackk config hangs)

- **Why:** a half-open cloud endpoint must never stop the **local** printer path
  from working. (Bug #2: boot used to hang forever awaiting the config fetch.)
- **Do:** point the agent at a black-hole that accepts TCP but never replies:
  ```bash
  # terminal 1: a socket that accepts and hangs
  node -e "require('net').createServer(()=>{}).listen(59999,'127.0.0.1')"
  # terminal 2: boot the agent at it
  SNACKK_URL=http://127.0.0.1:59999 SNACKK_DEVICE_KEY=x \
  PRINT_HTTP_PORT=4010 PRINT_DISCOVERY=off PRINT_STORE_DIR=memory node src/index.js
  ```
- **Expect:** the agent logs `print-agent listening on :4010` within a second, and
  `curl http://localhost:4010/health` returns immediately with
  `snackk.state: "starting"`.
- **Pass:** `/health` answers in well under the 15s config timeout. (In our run:
  **241 ms**.) The local `POST /print` path works even though snackk is hung.
- **Automated equivalent:** the connect-timeout test in `snackk-subscribe.test.js`.

#### F3-2 — Idle watchdog / silent drop (wifi off) — **the headline test**

- **Why:** the #1 field failure. A NAT/wifi/sleep drop kills the TCP link with
  **no FIN**, so `reader.read()` would block forever and printing silently stops.
  The idle watchdog must notice the silence and reconnect.
- **Do:** with the agent connected (`/health` shows 3/3), **turn the box's wifi
  OFF** for ~75 seconds, then back ON. Watch `/health`:
  ```bash
  for i in $(seq 6); do
    curl -s http://localhost:4010/health \
      | python3 -c "import sys,json;f=json.load(sys.stdin)['snackk']['feeds'][0];print('idle',f['idleForMs'],'conn',f['connected'],'connects',f['connects'])"
    sleep 13
  done
  ```
- **Expect:**
  1. `idleForMs` **climbs steadily past 60000** while `connects` stays frozen —
     the socket *looks* alive (no error surfaced): this is the silent drop.
  2. At ~60s the watchdog fires: the log shows `disconnected` and the reconnect
     loop starts retrying (`fetch failed` while wifi is down).
  3. When wifi returns: `subscribed kitchen/bar/bills`, `connects` increments,
     `seeds` increments (board re-seeded), `idleForMs` drops back to the sawtooth.
- **Pass:** the agent recovers **on its own** to `connected: 3`. The tell-tale is
  the **full 60s idle climb with no reconnect until the watchdog fires** — that
  proves the watchdog (not a surfaced TCP error) is what broke the wedge. Then a
  fresh order still prints.
- **Harsher variant (true black-hole, needs sudo):** instead of wifi, firewall the
  snackk IP so packets are dropped silently:
  ```bash
  # macOS pf: drop outbound to the resolved snackk IP for 70s, then restore
  # (only if you want to test without touching wifi)
  ```

#### F3-3 — Reconnect on server restart

- **Why:** proves clean-drop recovery + **seed-on-reconnect** (no lost KOTs).
- **Do:** `env -u COMPOSE_FILE docker compose -f docker-compose.local.yml restart app`
  (local), or redeploy on Render.
- **Expect (log):** `… disconnected: terminated/fetch failed` → ~1–2s later
  `subscribed kitchen/bar/bills` → for each board ticket still open,
  `→ duplicate (seed)`.
- **Pass:** `connected` returns to 3; any ticket that was on the board is
  re-seeded and **deduped** (no reprint). `connects` incremented by 1.

#### F3-4 — Periodic reconcile (missed KOT while still connected)

- **Why:** some misses happen with the stream *up* (a swallowed publish, a dropped
  frame). The reconcile re-seed heals them within ~90s without a reconnect.
- **Do:** hard to force naturally; observe it instead. Leave an order **open on the
  board** and watch the log — every ~90s you'll see the station re-seed. If a
  ticket had been missed, this is where it prints.
- **Expect:** periodic `→ duplicate (seed)` lines for still-open tickets (proving
  the reconcile runs and is idempotent).
- **Pass:** no double paper for already-printed tickets; a genuinely-missed one
  prints on the next tick.

#### F3-5 — Idempotency / no double print

- **Why:** replays (reconnect + reconcile + hub buffer overlap) must never
  reprint.
- **Do:** place an order, let it print, then `restart app` (F3-3) a few times.
- **Expect:** the KOT prints **once**; every subsequent seed logs
  `→ duplicate (seed)`.
- **Pass:** exactly one physical slip per ticket, regardless of reconnect count.
  (Backed by the durable `id@revision` store in `.queue/seen.json`.)

#### F3-6 — Printer outage fault tolerance

- **Why:** the printer can be unplugged mid-service; jobs must survive and resume.
- **Do:** start an order printing, then **unplug the printer** (or pull its
  network). Place another order. Re-plug after ~30s.
- **Expect:** `/health` shows `pos.healthy: false` and `depth` rising; the agent
  retries with backoff. On re-plug, the queue drains and **all** slips print in
  order.
- **Pass:** no lost slips after recovery. A job that fails `maxAttempts` (8) times
  is **dead-lettered** (moved aside, not silently dropped) — check
  `.queue/` for dead-letter files if a slip never prints.
- **Offline tool:** `npm run verify offline` scripts this interactively.

#### F3-7 — Config staleness on a mode flip

- **Why:** the agent polls config every 30s, so a flip (e.g. `both` → `kds`) takes
  up to 30s to apply.
- **Do:** in snackk, change `stationDelivery` to `kds`. Immediately place an order.
- **Expect:** for up to ~30s the agent may still print (stale config); within 30s
  `/health` shows `config.stationDelivery: kds` and new orders stop printing.
- **Pass:** the change takes effect within ~30s; no crash, no stuck state.

#### F3-8 — Bill recovery (settled while the agent was offline)

- **Why:** a `bill.print` fired while the agent is down goes to a channel with no
  subscriber and is gone. Recovery must re-fetch it (§11.7).
- **Do:** **stop the agent** (Ctrl-C). In snackk, **settle** a tab (§8 Step 6).
  **Restart the agent.**
- **Expect (log):** on connect, `[snackk] subscribed bills` then
  `[snackk] bill <sessionId> → queued` for the settled tab (from `seedBills`).
  A second settle-while-up prints live; a restart after that logs `→ duplicate`.
- **Pass:** exactly **one** customer bill prints for the settled tab, even though
  the settle happened with no agent connected. `feeds[bills].seeds` ≥ 1.

#### F3-9 — VOID recovery (voided while offline, and across a restart)

- **Why:** a void is terminal — never on a board — so only the voids snapshot can
  recover it, and the "did we print the KOT?" gate must survive a restart (§11.7).
- **Do:** place an order so the **KOT prints**. **Stop the agent.** In snackk,
  **void** that whole ticket. **Restart the agent.**
- **Expect (log):** on connect, after the board seed, `[snackk] kitchen <orderId>
  → queued (void-seed)` — the slip prints because the durable store still knows the
  KOT was printed before the restart.
- **Pass:** exactly **one** VOID slip prints. Control: void an order whose KOT the
  agent **never** printed (fired+voided entirely while offline) → **no** VOID slip
  (`void-never-printed`), which is correct — nothing was ever sent to pull.

---

## 10. Part G — Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `/health` `snackk.state: off` | `SNACKK_URL`/`SNACKK_DEVICE_KEY` not set. | Set both env vars. |
| `snackk.state: awaiting-config` (stuck) | snackk unreachable or printing not enabled for this tenant → config 404. | Check the URL; enable printing + confirm the key isn't rotated. |
| Feeds `connected: false`, log `HTTP 401` | Device key wrong or rotated. | Re-mint in Settings; update `SNACKK_DEVICE_KEY`. |
| Feeds connected but nothing prints | `stationDelivery: kds` (paper off), or wrong stations subscribed. | Set delivery to `print`/`both`; check `SNACKK_STATIONS`. |
| `no printer configured for station "X"` | A station has no printer mapping. | Add the station to a printer's `stations` in config/`printers.json`. |
| Slips print but tail bleeds onto next | Wrong cut command. | Ensure `GS V 66` in `escpos.js` (already fixed). |
| Devanagari items print garbage | latin1 codepage vs देवनागरी (#9). | Romanize/transliterate item names or change codepage. |
| Bill time wrong | Host timezone not Kathmandu (#10). | `timedatectl set-timezone Asia/Kathmandu`. |
| `idleForMs` never resets / climbs past 60s repeatedly | Heartbeat not arriving (proxy strips SSE, or truly dead). | Watch for reconnect; if it never recovers, check the proxy passes `text/event-stream` unbuffered. |
| Boot hangs | (Should be impossible now.) Old build without the fix. | Pull latest; listen is independent of the agent. |

**Where to look:** the agent log (stdout / pm2 logs), `/health`, and `.queue/`
(pending + dead-letter jobs + `seen.json` idempotency window).

---

## 11. Part H — Reliability design reference

The mechanisms that make the link trustworthy, and where they live.

> **Known deferred findings:** see [`DEFERRED_AUDIT_FINDINGS.md`](./DEFERRED_AUDIT_FINDINGS.md)
> for the accepted-but-not-yet-fixed items from the 2026-08-08 production audit
> (merged-tab duplicate receipt, VAT-inclusive receipt reconciliation, `print`
> ≡ `both`, recovery re-scan cost, and lower-severity notes).

### 11.1 Idle watchdog + connect timeout
`src/inbound/snackk/subscribe.js` (`openStream`, `pump`). Every stream carries an
`AbortController`. A **connect timeout** (15s) bounds the initial fetch; an **idle
watchdog** (60s ≈ 2.4× snackk's 25s heartbeat) re-arms on every byte and aborts
the socket on silence, turning a wedged NAT link into a fast reconnect.

### 11.2 Seed-on-reconnect
On every (re)connect the agent GETs `/api/print/station/:station/active` and
prints anything on the board not already in the durable store — so a KOT that
fired during a gap still prints. Deduped, so a re-seed never reprints.

### 11.3 Periodic reconcile
An independent ~90s timer re-runs the seed regardless of stream health, closing
the "missed while connected" gap (swallowed publish, dropped frame, config-null
window). Safe because the idempotency reserve is atomic — a reconcile racing the
live path cannot double-print.

### 11.4 Idempotency (exactly-once)
`src/core/service.js` + `src/adapters/store/idempotency-file.js`. Each ticket has a
key `id@revision`; `reserve()` is synchronous and atomic, so concurrent/replayed
prints collapse to one. Durable across restarts (`.queue/seen.json`, bounded FIFO
of 10,000 keys).

### 11.5 Money passthrough (#5)
`src/inbound/snackk/map.js` (`parseNpr`, `billToTicket`). Exact integer paisa where
snackk exposes it (`totalPaisa`, `discountPaisa`); for the rest, snackk's display
string (`रू 1,951.51`) is **parsed** (not recomputed) into the same number and
re-rendered as ASCII `Rs`. Verified: `parseNpr("रू 1,951.51") === 1951.51`. If
snackk ever changes `formatNPR` to non-Latin digits, revisit this.

### 11.6 Boot ordering
`src/index.js`. `app.listen` binds **before** the snackk agent starts (agent runs
in the background), so the local HTTP inbound is never blocked by a slow cloud.

### 11.7 Recovery of settled bills & VOID slips (offline/restart)
A KOT sits on a board, so `active` re-seeds it. A **settled bill** and a
**whole-ticket void** are *terminal* — neither appears on a board — so they need
their own recovery source. Two snapshot endpoints, replayed on every (re)connect
**and** the ~90s reconcile, exactly like the board seed:

- **Bills** — `subscribeBills.seedBills()` GETs `/api/print/bills/recent?since=`;
  each recently settled bill maps through the same `billToTicket` as the live
  `bill.print`, so the `bill:<sessionId>` key dedupes a bill that already printed.
  (Screens-only tenants get an empty list — the server gates it like the live emit.)
- **Voids** — `subscribeStation.seedVoids()` GETs
  `/api/print/station/:station/voids/recent?since=`; each recently voided order
  prints a VOID slip **only if its KOT was printed**, and the `id@0:void` key dedupes.

The "was the KOT printed?" gate is now **durable**: `printed.has(orderId)` falls
back to `service.hasPrinted('<orderId>@0')`, which reads the on-disk idempotency
store — so a KOT committed *before* a restart still gates its void afterwards
(the old in-memory-only set forgot on reboot). `since` is a bounded, server-clamped
trailing window (12h default, 24h cap), so the scan can never be unbounded; the
durable store makes every re-seed idempotent, so the window can be generous.

### 11.8 Known, accepted gaps
- **Whole lifecycle offline:** an order that both *fired and voided* while the
  agent was down never printed a KOT, so no VOID slip is emitted on recovery
  (there is nothing to pull — the correct outcome).
- **Idempotency window** is 10,000 keys — a KOT sitting on the board (or awaiting
  its void) across 10k *distinct* subsequent prints could reprint / stop gating on
  re-seed. Implausible at real volumes.

---

## 12. Appendix

### 12.1 Agent env-var cheat-sheet
See [§4.3](#43-environment-variables).

### 12.2 snackk endpoints the agent uses

| Method & path | Auth | Purpose |
|---------------|------|---------|
| `GET /api/print/config` | device key | Delivery mode, routing mode, receipt identity. Polled every 30s. |
| `GET /api/print/station/:station/active` | device key | Board snapshot for seed/reconcile (KOT/BOT recovery). |
| `GET /api/print/station/:station/voids/recent?since=` | device key | Recently voided orders — VOID-slip recovery on (re)connect + reconcile. |
| `GET /api/print/bills/recent?since=` | device key | Recently settled bills — receipt recovery on (re)connect + reconcile. |
| `GET /api/stream/print/station/:station` | device key | Live SSE KOT/BOT feed (`ticket.new`/`ticket.updated`). |
| `GET /api/stream/print/bills` | device key | Live SSE bill feed (`bill.print`). |
| `POST /api/settings/printing/enable` | owner cookie | Turn the feature on + set delivery (first enable seeds delivery). |
| `POST /api/settings/printer-device` | owner cookie | Mint/rotate the `snkp_…` device key (shown once). |

### 12.3 Command cheat-sheet

```bash
# agent
npm install ; node --test                       # install + 148 tests
npm start                                        # standalone HTTP print server
npm run verify cuts|waiters|offline|crash-*      # offline printer drills

# snackk local
env -u COMPOSE_FILE APP_PORT=3000 DB_PORT=5433 \
  docker compose -f docker-compose.local.yml up --build -d
npx tsx scripts/seed-demo.ts                     # (with DATABASE_URL, see §7.2)
npx vitest run ; npm run lint ; npx vite build   # unit + typecheck + build

# snackk DB-gated (safe, targeted)
node --env-file=.env.test ./node_modules/.bin/vitest run tests/print.test.ts

# health
curl -s http://localhost:4010/health | python3 -m json.tool
```

### 12.4 See also
- `docs/THERMAL_PRINTING.md` in the **snackk** repo — the cloud side (endpoints, enable, deploy).
- [`README.md`](../README.md) — agent overview & ticket format.
- [`VERIFY.md`](../VERIFY.md) — hands-on printer verification.
