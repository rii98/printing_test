# Deferred Audit Findings — snackk thermal-printing integration

**Status: DEFERRED — accepted, to be fixed later. None of these block the current
E2E; they are logged here so they are not lost.**

Production-grade QA audit of `printing_test:feat/snackk-integration` ×
`snackk:feat/thermal-printing`, dated **2026-08-08**. At audit time the agent
suite was `148/148` green and the snackk print suite `20` green (`19` DB-gated
tests skip without Postgres). The findings below are **surfaced but not yet
fixed** in code (A3's *doc* was corrected; its *code* is deferred).

Severity is operational impact, not exploitability. Repo paths are relative to
each repo root: `printing_test/` = the on-prem print agent, `snackk/` = the cloud app.

| ID | Sev | One-line | Fix lives in |
|----|-----|----------|--------------|
| [A1](#a1--med--merged-tab-can-print-a-duplicate-receipt) | MED | Merged tab settled via a non-primary session prints the receipt twice | `printing_test/src/inbound/snackk/map.js` |
| [A2](#a2--med--vat-inclusive-receipts-dont-reconcile) | MED | VAT-inclusive receipt: line items don't sum to the printed subtotal | `printing_test/src/inbound/snackk/map.js` + `src/core/render/layouts/bill.js` |
| [A3](#a3--med--print-and-both-are-behaviourally-identical) | MED | `print` mode does not disable the KDS (doc corrected; code deferred) | `snackk/server/routes/stream.ts` + KDS console |
| [A4](#a4--med-efficiency--reconcile-re-scans-the-full-12h-window-every-90s) | MED | Bill/void recovery re-scans the full 12h window every 90s (N+1) | `printing_test/src/inbound/snackk/subscribe.js` + `snackk/server/billing/bill.ts` |
| [A5](#a5--low--agent-treats-feature-disabled-404-like-a-transient-error) | LOW | Disabled tenant keeps a stale cached `stationDelivery` on `/health` | `printing_test/src/inbound/snackk/config.js` |
| [A6](#a6--low--recovery-endpoints-gate-delivery-mode-inconsistently) | LOW | Only `recentBills` gates on `kds`; voids/active rely on agent filtering | `snackk/server/controllers/print.ts` |
| [A7](#a7--low--agent-health-is-unauthenticated) | LOW | Agent `/health` leaks shop name, printer IPs, snackk URL, mode | `printing_test/src/inbound/http.js` |
| [R1](#r1--residual-by-design--fire-and-leave-the-board-while-offline) | RESIDUAL | KOT that fires *and* leaves the board while offline is unrecoverable | design limit — document only |

---

## A1 · MED · Merged tab can print a duplicate receipt

**What.** `billToTicket` keys the receipt idempotency id as `bill:<sessionId>`.
The **live** settle emits with the *settled* session id (`billing.ts` →
`publishBillPrint(bill)`, where `bill.sessionId` is the URL param the cashier hit),
but the **recovery** path (`loadSettledBillsSince`) selects the row that carries
the bill number — the merged-group **primary** session. When the settled session
≠ the primary, the two idempotency keys differ, so the ~90s recovery re-seed
prints the receipt a **second time**.

**Reachability.** The counter tabs list settles via `sessionId: primaryId`
(`billing.ts listOpen`), so the normal UI path is safe. Any settle on a
non-primary member session (a different surface, a stale/guest-supplied id, a
retry) double-prints.

**Fix (deferred).** Key the receipt on the stable per-bill number instead of the
session id — identical on both the live and recovery paths:

```js
// printing_test/src/inbound/snackk/map.js — billToTicket
id: `bill:${bill.billNumber}`,   // was `bill:${bill.sessionId}`
```

`billNumber` is always present on a settled bill (the emit only fires on settle),
unique per restaurant, and the agent is single-tenant. Add a merged-tab
regression test (settle a non-primary member → recovery must dedupe).

---

## A2 · MED · VAT-inclusive receipts don't reconcile

**What.** For `pricesIncludeVat = true` tenants the agent prints **gross**
per-line amounts (`parseNpr(l.lineTotal)`) but a **net** "Subtotal"
(`parseNpr(bill.subtotal)` is the *taxable value*, VAT backed out), with nothing
bridging the gap. The itemized lines therefore do **not** sum to the printed
"Subtotal". The grand total is still correct.

snackk's own surfaces already solve this in `snackk/src/console/billing/billBreakdown.ts`:
inclusive bills lead with **"Item total (incl. VAT)"** (`itemsSubtotal`, ties to
the lines) then a muted **"Taxable value"** (`subtotal`). The thermal receipt
reintroduces the exact non-reconciliation that module was written to avoid, and
breaks the docs' "subtotal … match exactly" claim.

**Reachability.** Only tenants who opt into `pricesIncludeVat` (schema default is
`false`, but VAT-inclusive menu pricing is common in Nepal).

**Fix (deferred).** Carry `itemsSubtotal` + `pricesIncludeVat` through
`billToTicket`, and teach the trusted-breakdown path in
`printing_test/src/core/render/layouts/bill.js` the inclusive two-line
presentation (gross "Item total (incl VAT)" + muted "Taxable value"), mirroring
`billBreakdown.ts`. Do **not** simply swap in `itemsSubtotal` as the subtotal —
that would double-count when VAT is added on top.

---

## A3 · MED · `print` and `both` are behaviourally identical

**What.** No code — server or console — reads `stationDelivery` to suppress the
KDS. Only `snackk/server/controllers/print.ts` and `server/billing/bill.ts` read
it; the staff KDS stream gates on `requireFeature("kds")`, and no console
component except `PrintingCard.tsx` references `stationDelivery`. So "Print only"
never darkens the screens — `print` is behaviourally the same as `both`.

**Doc status:** already corrected in `snackk/docs/THERMAL_PRINTING.md` (mode-table
`†` footnote + the troubleshooting row). **Code deferred:** if a real screens-off
mode is wanted, gate `GET /api/stream/station/:station` and the KDS console on
`stationDelivery !== 'print'`. Until then `print` is an operational signal, not a
screen kill-switch.

---

## A4 · MED (efficiency) · Reconcile re-scans the full 12h window every 90s

**What.** `seedBills`/`seedVoids` always send `?since=now−12h`, on every
(re)connect **and** every 90s reconcile, per agent. Server-side
`loadSettledBillsSince` runs an **N+1 `loadBill`** per settled bill (up to
`RECOVERY_MAX_ROWS = 200`) each time — in steady state, rebuilding the whole
window only to find nothing new. Separately, the 200-row cap means a
**>200-bill offline window silently drops the oldest** bills from recovery.

**Fix (deferred).** Advance a high-water `since` cursor to the newest
successfully-processed `closedAt` (fall back to a small overlap to tolerate clock
skew / late arrivals); consider a slower bill-reconcile cadence than the KOT one;
and/or a cheap server-side "any new since?" probe before the full rebuild.
Revisit the 200-row cap for busy venues with multi-day outages.

---

## A5 · LOW · Agent treats feature-disabled (404) like a transient error

**What.** When an owner turns printing off, all device endpoints return 404
(feature disabled). `printing_test/src/inbound/snackk/config.js` treats that like
any network blip ("keeping last, will retry"), so the cached `stationDelivery`
goes stale and `/health` keeps reporting the old mode; logs get noisy across
reconnect/reconcile cycles. Harmless in effect — the data endpoints also 404, so
no tickets flow — but misleading. Consider clearing the cache on a 404, mirroring
the loud 401 handling.

---

## A6 · LOW · Recovery endpoints gate delivery-mode inconsistently

**What.** `recentBills` returns `[]` for a `kds` (screens-only) tenant, but
`recentVoids` and `activeTickets` do **not** gate server-side — they serve rows
and rely on the agent's `printActionSeed`/`printActionVoidSeed` to skip. Not
exploitable (the device key is tenant-scoped and the agent filters), but a
screens-only tenant's ticket/void data is still served to the paired device.
Gate all three consistently, or document why only bills gate.

---

## A7 · LOW · Agent `/health` is unauthenticated

**What.** `GET /health` on the agent (`printing_test/src/inbound/http.js`) is
open and exposes shop name, printer IPs, the snackk URL, and the delivery mode.
LAN-only, low risk. Consider binding `/health` to localhost, or requiring the
API key for the snackk/config detail while keeping a bare liveness field public.

---

## R1 · RESIDUAL (by design) · Fire-and-leave-the-board while offline

**What.** A KOT that both **fires and leaves the board** during a disconnect —
beyond the 64-event hub replay buffer, or at all in print-only mode where the
channel and its buffer drop when the last subscriber leaves — is unrecoverable,
because re-seed (`seedActive`) is board-only. Acknowledged in code comments.

**Mitigation (document, not fix).** In `both` mode, keeping a KDS subscribed
preserves the channel + buffer across the agent's blips. A larger buffer or a
short-window "recently-bumped tickets" recovery endpoint would shrink the gap.
A missing VOID/KOT here is rarer than the outages already covered.
