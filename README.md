# print-agent

A small, robust **LAN print agent** for restaurant ticketing — **KOT** (kitchen),
**BOT** (bar), and **customer bills** — driving ESC/POS thermal printers over the
network. Built to be dropped into any restaurant: loosely coupled, durable,
fault-tolerant, and verifiable without a printer.

It is deliberately **standalone** and independent of any POS/backend. Integration
with an upstream system (e.g. snackk) is one thin adapter — see
[Integrating with a POS](#integrating-with-a-pos).

---

## Why it exists / where it runs

Your POS backend may live in the cloud, but a thermal printer sits on the
restaurant's **private LAN** behind NAT — the cloud can't reach it directly. So a
small always-on process **inside the restaurant** bridges the two: it receives
tickets and speaks ESC/POS to the printers on the local network.

```
  devices / POS  ──►  print-agent (this)  ──►  printers on the LAN (:9100)
                       one always-on box
```

Run it on any always-on machine on the shop LAN — a **Raspberry Pi** or mini PC is
ideal; a desktop works. It only needs to reach the printers and (later) your POS.

---

## Quick start

```bash
npm install
npm test               # 31 unit tests, no printer needed
npm run preview        # see KOT/BOT/BILL/VOID in the terminal (no printer)
npm run discover       # find printers on the LAN, show IP + MAC
npm run print bill     # print a sample to the real printer
npm start              # run the HTTP print server (port 4000)
```

Devices then print by POSTing a ticket:

```bash
curl -X POST http://<agent-ip>:4000/print -H 'Content-Type: application/json' -d '{
  "id": "order-42", "station": "kitchen", "table": "5",
  "items": [{ "name": "Chicken Momo", "qty": 2, "modifiers": ["No garlic"] }]
}'
```

---

## Architecture (hexagonal / ports & adapters)

The **core** (render, route, queue) is pure and knows nothing about HTTP, SSE,
TCP, or any POS. Everything external is an **adapter** you can swap or fake.

```
  INBOUND adapters            CORE (pure, unit-tested)            OUTBOUND adapters
 ┌──────────────────┐   ┌───────────────────────────────┐   ┌────────────────────┐
 │ HTTP server      │   │ PrintService                  │   │ TCP transport :9100 │
 │ (SSE subscriber) │──►│  validate→dedupe→route→render │──►│ Fake transport(test)│
 │ CLI / samples    │   │        ┌──────────────┐       │   └────────────────────┘
 └──────────────────┘   │        │ per-printer  │       │   ┌────────────────────┐
                        │        │ durable queue│       │   │ Store: file / memory│
                        │        │ retry+DLQ    │       │   └────────────────────┘
                        │        └──────────────┘       │   ┌────────────────────┐
                        └───────────────────────────────┘   │ Discovery (scan+MAC)│
                                                             └────────────────────┘
```

Files:

| Path | Role |
|---|---|
| `src/core/domain.js` | Neutral `Ticket` type + validation. **Not** coupled to any POS DTO. |
| `src/core/render/` | `Doc` model + layouts (`kitchen`, `bill`, `void`) + two encoders |
| `src/core/render/escpos.js` | `Doc → ESC/POS bytes` (self-contained; bold, QR, cut, drawer) |
| `src/core/render/preview.js` | `Doc → plain text` — preview receipts with no printer |
| `src/core/queue.js` | Durable, serial, retrying **per-printer** queue |
| `src/core/service.js` | Orchestrator: dedupe → route → render → enqueue |
| `src/adapters/transport/` | `tcp` (real) + `fake` (tests) |
| `src/adapters/store/` | `file` (durable, atomic) + `memory` (tests) |
| `src/adapters/discovery/` | LAN scan for :9100, resolve MAC |
| `src/inbound/http.js` | HTTP API (swap for SSE at integration time) |
| `src/bootstrap.js` / `src/index.js` | wiring + entrypoint + graceful shutdown |

**Key design choices**

- **Neutral domain, not the POS's** → zero coupling; integration is one adapter.
- **`Doc` intermediate model** → layouts are tested as data; a text preview means
  every receipt is reviewable without hardware; adding PDF/HTML output is just
  another encoder.
- **Durable per-printer queue** → a ticket is persisted *before* it's acknowledged;
  transient failures retry with capped backoff+jitter; after `maxAttempts` a job
  moves to a **dead-letter** folder (never silently dropped) and the line keeps
  moving. FIFO and single-connection (:9100 allows one) are guaranteed.
- **Idempotency by `id@revision`** → re-delivery/replay never double-prints; a new
  revision reprints (e.g. an edited order).
- **Discovery by MAC** → the printer's IP can change; nothing breaks.

---

## The ticket format

One neutral shape for every station (see `src/core/domain.js` for the full spec):

```jsonc
{
  "id": "order-42",           // stable unique id — the idempotency key (required)
  "revision": 0,               // bump to reprint an edited ticket
  "number": 42,                // human ticket number
  "station": "kitchen",        // kitchen | bar | cashier  (required)
  "orderType": "dine-in",      // dine-in | takeaway | delivery
  "table": "5", "server": "Ram",
  "items": [
    { "name": "Chicken Momo", "qty": 2, "modifiers": ["No garlic"], "note": "hot" },
    { "name": "Mojito", "qty": 1, "price": 250 }   // price only used on bills
  ],
  // bill-only:
  "currency": "Rs", "discount": 100, "serviceCharge": 130,
  "taxRate": 0.13, "taxLabel": "VAT 13%", "total": 2373,
  "payment": "Cash", "qr": "https://…", "footer": "Thank you", "openDrawer": true,
  // cancellation:
  "voided": true, "voidReason": "Guest left"      // → prints a loud VOID slip
}
```

- **KOT/BOT** render item names + qty + modifiers, **no prices**.
- **BILL** computes subtotal → discount → service → tax → total (or trusts an
  explicit `total`), plus QR, payment, footer, optional drawer kick.
- A `voided` ticket prints a **VOID** slip at its station regardless of type.

---

## Configuration

Defaults live in `src/config.js`. Override per-site with a **`printers.json`** in
the project root (git-ignored), then with `PRINT_*` env vars. A printer is keyed
by an id and bound to a **station**; give it a fixed `host` **or** a `mac` to
discover:

```json
{
  "shop": { "name": "NAMASTE RESTAURANT", "lines": ["Kathmandu", "01-5555555"] },
  "printers": {
    "cashier": { "station": "cashier", "host": "192.168.18.240", "width": 48 },
    "kitchen": { "station": "kitchen", "mac": "aa:bb:cc:dd:ee:ff", "width": 48 },
    "bar":     { "station": "bar",     "mac": "11:22:33:44:55:66", "width": 32 }
  }
}
```

`width`: **48** for 80mm, **32** for 58mm. Env: `PRINT_HTTP_PORT`,
`PRINT_SHOP_NAME`, `PRINT_STORE_DIR` (`memory` to disable persistence),
`PRINT_DISCOVERY=off`, `PRINT_SUBNET`, `PRINT_LOG=json`.

### Setting up at a new restaurant

1. `npm run discover --identify` — scans the LAN and prints an **"I am …"** slip on
   each printer showing its IP + MAC.
2. Put each printer's **MAC** under the right station in `printers.json`.
3. `npm start`. The agent finds each printer by MAC even if its IP later changes.

---

## Fault tolerance — what happens when things go wrong

| Situation | Behavior |
|---|---|
| Printer briefly offline | Retries with exponential backoff + jitter; prints when it returns |
| Printer offline past `maxAttempts` | Job → **dead-letter** folder (`.queue/dead`), kept for reprint; line continues |
| Agent crashes mid-print | Pending jobs persisted in `.queue/pending`; **recovered and drained on restart** |
| Two devices print at once | Serialized per printer — no interleaved/garbled tickets |
| Duplicate/replayed ticket | Dropped (idempotency); a new `revision` reprints |
| Invalid ticket | Rejected with a clear error; nothing printed |
| Wrong/unset station | Clear `no printer configured for station …` error |

> Observed live during development: the printer was unplugged mid-test — the agent
> logged `OFFLINE`, retried, dead-lettered without losing anything, and resumed
> cleanly when power returned.

---

## Integrating with a POS

The core takes a neutral `Ticket`. To connect an upstream system you write **one
adapter** that maps its events to `service.print(ticket)` — no core changes.

For a cloud POS (e.g. snackk), the agent runs on-prem and **subscribes outbound**
to the POS's per-station ticket stream (SSE) — the same stream a KDS uses — then
prints each ticket. Because the agent dials out, **the agent's own IP never needs
to be fixed**, and NAT is a non-issue.

> **The snackk integration is built** (see `src/inbound/snackk/`). For the full
> operations + testing playbook — printer setup, running against local Docker or
> Render, the `/health` dashboard, and the network-failure drills (idle watchdog,
> reconnect, reconcile, printer outage) — see
> **[`docs/SNACKK_INTEGRATION.md`](docs/SNACKK_INTEGRATION.md)**.

---

## Running it always-on (production)

```bash
npm i -g pm2
pm2 start src/index.js --name print-agent
pm2 startup && pm2 save     # relaunch on boot / restart on crash
```

Prefer a dedicated always-on box (Raspberry Pi / mini PC). The code is portable
Node — only the printer addresses change between sites.

---

## Testing

`npm test` runs the full unit suite (137 tests) on the pure core (format, layouts,
ESC/POS encoding, queue retry/dead-letter/recovery, routing, idempotency,
validation) **plus the snackk SSE adapter** (parser, mapper/print-policy, idle
watchdog, connect timeout, reconcile, `/health` status) using Node's built-in
runner and in-memory fakes — **no printer, no network, deterministic.**

For the snackk integration's operations + full testing/drill playbook, see
**[`docs/SNACKK_INTEGRATION.md`](docs/SNACKK_INTEGRATION.md)**.
