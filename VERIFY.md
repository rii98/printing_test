# Hands-on printer verification

Run these one at a time against the real printer and check the paper. Each script
prints what to expect. `crash-stage` + `crash-recover` are already verified ✓.

```bash
npm run verify cuts            # cutter
npm run verify waiters         # concurrency (multiple waiters)
npm run verify offline         # unplug / replug — fault tolerance (interactive)
npm run verify crash-stage     # then:
npm run verify crash-recover   # durability across a restart   ✓ verified
```

---

### 1. Cuts — `npm run verify cuts`
Prints 3 tickets.

- [ ] **3 physically separate slips** come out (not one long strip).
- [ ] Each is **cleanly cut** — no ticket sharing paper with the next.
- [ ] Nothing is sliced through the text.

---

### 2. Multiple waiters (concurrency) — `npm run verify waiters`
3 waiters fire 3 tickets each **at the same instant** (9 total) to one printer.

- [ ] **9 clean slips** total.
- [ ] **None garbled or interleaved** — no slip has two tickets mixed together.
- [ ] Each shows its **Waiter A/B/C** and **ticket n/3** clearly.

> This is the important one: it proves two waiters hitting the printer at the same
> moment can't collide (port 9100 allows only one connection — the queue serializes).

---

### 3. Offline / reconnect — `npm run verify offline`  *(interactive)*
Proves a ticket is **never lost** during an outage and prints when the printer returns.

1. When prompted, **unplug** the printer (power or ethernet), press Enter.
2. It queues a ticket — you'll see it log `OFFLINE` and `retry …` (it keeps trying).
3. When prompted, **plug it back in**, press Enter, wait.

- [ ] Terminal shows `printer back ONLINE` / the job drains.
- [ ] The **"OFFLINE TEST — I survived the outage"** slip prints after reconnect.
- [ ] Nothing was lost.

---

### 4. Crash durability — `npm run verify crash-stage` → `npm run verify crash-recover`  ✓
- `crash-stage` accepts 3 jobs, persists them, and exits **without printing** (a
  crash right after accepting an order).
- `crash-recover` restarts the agent.

- [ ] On restart it logs `recovered 3 job(s)` and the **3 CRASH-RECOVERY slips print**.
- [ ] `.queue/pending` ends empty.

*(Already run during setup — 3 slips printed, pending cleared.)*

---

### Reset between runs
Clear any leftover queue state:
```bash
rm -f .queue/pending/*.json .queue/dead/*.json
```

### What a failure would look like (so you know it's real)
- Garbled/interleaved slip in **waiters** → serialization broken.
- A slip lost after reconnect in **offline** → durability broken.
- Missing slips after **crash-recover** → recovery broken.

If any of these happen, tell me the scenario and what came out — that's a real bug
to fix before we touch snackk.
