import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fireState,
  isPrintFire,
  isVoid,
  orderTicketToTicket,
  lineVoidChitToTicket,
  printActionVoidSeed,
  parseNpr,
  billToTicket,
} from '../src/inbound/snackk/map.js';
import { normalizeTicket, ticketKey } from '../src/core/domain.js';
import { computeTotals } from '../src/core/render/layouts/bill.js';
import { renderTicket } from '../src/core/render/index.js';
import { toText } from '../src/core/render/preview.js';

/** A minimal OrderTicketDto as snackk streams it. */
const dto = (over = {}) => ({
  orderId: '11111111-1111-1111-1111-111111111111',
  sessionId: '22222222-2222-2222-2222-222222222222',
  tableLabel: 'T3',
  station: 'kitchen',
  state: 'received',
  ticketNumber: 7,
  voidReason: null,
  priority: 0,
  placedAt: '2026-08-08T10:00:00.000Z',
  lines: [
    { id: 'l1', itemId: 'i1', itemName: 'Chicken Chilli', variantName: 'Full', quantity: 2,
      modifiers: [{ name: 'Extra spicy', priceDelta: '0' }], note: 'no onion', prepMinutes: null, course: null },
  ],
  ...over,
});

// ── fire state / print moment ──────────────────────────────────────────────

test('fireState is received in direct mode, confirmed in waiter_confirm', () => {
  assert.equal(fireState('direct'), 'received');
  assert.equal(fireState('waiter_confirm'), 'confirmed');
});

test('direct mode prints on received, not on later states', () => {
  assert.equal(isPrintFire(dto({ state: 'received' }), 'direct'), true);
  assert.equal(isPrintFire(dto({ state: 'preparing' }), 'direct'), false);
  assert.equal(isPrintFire(dto({ state: 'ready' }), 'direct'), false);
});

test('waiter_confirm prints on confirmed, and NOT on the earlier received', () => {
  // The key non-regression: a still-unconfirmed order must not print.
  assert.equal(isPrintFire(dto({ state: 'received' }), 'waiter_confirm'), false);
  assert.equal(isPrintFire(dto({ state: 'confirmed' }), 'waiter_confirm'), true);
});

test('isVoid detects a whole-ticket cancellation', () => {
  assert.equal(isVoid(dto({ state: 'void' })), true);
  assert.equal(isVoid(dto({ state: 'received' })), false);
});

// ── translation ────────────────────────────────────────────────────────────

test('maps the core ticket fields through unchanged', () => {
  const t = orderTicketToTicket(dto());
  assert.equal(t.id, '11111111-1111-1111-1111-111111111111');
  assert.equal(t.revision, 0);
  assert.equal(t.number, 7);
  assert.equal(t.station, 'kitchen');
  assert.equal(t.table, 'T3');
  assert.equal(t.voided, false);
});

test('a zone qualifies the table name; no zone leaves the bare label', () => {
  // snackk allows the same label in two zones, so the slip must name the zone to
  // keep them apart on the pass.
  assert.equal(orderTicketToTicket(dto({ tableLabel: 'Koshi', tableZone: 'Garden' })).table, 'Koshi · Garden');
  assert.equal(orderTicketToTicket(dto({ tableLabel: 'Koshi', tableZone: null })).table, 'Koshi');
  assert.equal(orderTicketToTicket(dto({ tableLabel: 'Koshi' })).table, 'Koshi'); // zone absent
});

test('the pull-chit slip zone-qualifies the table too', () => {
  const chit = {
    orderId: '11111111-1111-1111-1111-111111111111',
    ticketNumber: 7,
    station: 'kitchen',
    tableLabel: 'Koshi',
    tableZone: 'Patio',
    placedAt: '2026-08-08T10:00:00.000Z',
    reason: 'Guest cancelled',
    batchId: '33333333-3333-3333-3333-333333333333',
    lines: [{ id: 'l1', itemName: 'Momo', variantName: null, quantity: 2, modifiers: [], note: null }],
  };
  const t = lineVoidChitToTicket(chit);
  assert.equal(t.table, 'Koshi · Patio');
  assert.equal(t.voided, true);
  assert.equal(t.items[0].voided, true);
});

test('inlines the variant into the dish name and flattens modifiers to names', () => {
  const [item] = orderTicketToTicket(dto()).items;
  assert.equal(item.name, 'Chicken Chilli (Full)');
  assert.equal(item.qty, 2);
  assert.deepEqual(item.modifiers, ['Extra spicy']);
  assert.equal(item.note, 'no onion');
  // A KOT/BOT never carries a price.
  assert.equal(item.price, undefined);
});

test('a line with no variant keeps the plain dish name', () => {
  const t = orderTicketToTicket(dto({ lines: [{ itemName: 'Momo', variantName: null, quantity: 1, modifiers: [], note: null }] }));
  assert.equal(t.items[0].name, 'Momo');
  assert.equal(t.items[0].modifiers, undefined);
  assert.equal(t.items[0].note, undefined);
});

test('a bar ticket maps to the bar station (→ BOT downstream)', () => {
  assert.equal(orderTicketToTicket(dto({ station: 'bar' })).station, 'bar');
});

test('a void carries voided:true and its reason', () => {
  const t = orderTicketToTicket(dto({ state: 'void', voidReason: 'guest left' }));
  assert.equal(t.voided, true);
  assert.equal(t.voidReason, 'guest left');
});

// ── contract: the output must be a VALID Ticket our core accepts ────────────

test('the mapped KOT passes normalizeTicket and keys as id@0', () => {
  const t = normalizeTicket(orderTicketToTicket(dto()));
  assert.equal(ticketKey(t), '11111111-1111-1111-1111-111111111111@0');
});

test('the void slip keys DISTINCTLY from the KOT, so both print', () => {
  const kot = ticketKey(normalizeTicket(orderTicketToTicket(dto({ state: 'received' }))));
  const voided = ticketKey(normalizeTicket(orderTicketToTicket(dto({ state: 'void' }))));
  assert.equal(kot, '11111111-1111-1111-1111-111111111111@0');
  assert.equal(voided, '11111111-1111-1111-1111-111111111111@0:void');
  assert.notEqual(kot, voided);
});

// ── bills (Slice B) ─────────────────────────────────────────────────────────

test('parseNpr reads snackk formatNPR strings (Devanagari symbol, grouping, sign)', () => {
  assert.equal(parseNpr('रू 1,234.56'), 1234.56);
  assert.equal(parseNpr('रू 0.00'), 0);
  assert.equal(parseNpr('-रू 50.00'), -50);
  assert.equal(parseNpr('रू 1,23,456.00'), 123456); // South-Asian grouping
  assert.equal(parseNpr(undefined), 0);
});

/** A BillDto as snackk's settle emits it (money as formatNPR strings + exact paisa). */
const billDto = (over = {}) => ({
  sessionId: '99999999-9999-9999-9999-999999999999',
  tableLabel: 'T7', mergedTables: ['T7'], status: 'closed', paid: true, billNumber: 42,
  restaurant: { name: 'Momo House', panNumber: '123456789' },
  openedAt: '2026-08-08T09:00:00Z', closedAt: '2026-08-08T10:00:00Z',
  serviceChargeRate: '10.00', vatRate: '13.00', pricesIncludeVat: true,
  lines: [{ itemName: 'Chicken Momo (Full)', quantity: 2, station: 'kitchen', ticketNumber: 3, state: 'served',
            modifiers: [{ name: 'Extra spicy', priceDelta: '0.00' }], unitPrice: 'रू 132.74', lineTotal: 'रू 265.49' }],
  itemsSubtotal: 'रू 300.00', subtotal: 'रू 265.49', discount: 'रू 15.49', discountPaisa: 1549,
  discountKind: 'percent', discountPct: '5.00', discountLabel: null,
  serviceCharge: 'रू 25.00', vat: 'रू 32.50', total: 'रू 307.50', totalPaisa: 30750,
  ...over,
});

test('billToTicket → a valid cashier Ticket, money passed through verbatim', () => {
  const t = normalizeTicket(billToTicket(billDto()));
  assert.equal(t.station, 'cashier');
  assert.equal(t.id, 'bill:99999999-9999-9999-9999-999999999999');
  assert.equal(ticketKey(t), 'bill:99999999-9999-9999-9999-999999999999@0');
  assert.equal(t.number, 42);
  assert.equal(t.table, 'T7');
  assert.equal(t.items[0].name, 'Chicken Momo (Full)');
  assert.equal(t.items[0].amount, 265.49);
  assert.deepEqual(t.items[0].modifiers, ['Extra spicy']);
  assert.equal(t.taxLabel, 'VAT (13%)');
  // Identity travels WITH the bill — the receipt prints the restaurant, not config.
  assert.equal(t.shopName, 'Momo House');
  assert.deepEqual(t.shopLines, ['PAN 123456789']);
  // The trusted breakdown is exactly snackk's — discount/total from exact paisa.
  const c = computeTotals(t);
  assert.deepEqual(
    { subtotal: c.subtotal, discount: c.discount, service: c.service, tax: c.tax, total: c.total },
    { subtotal: 265.49, discount: 15.49, service: 25, tax: 32.5, total: 307.5 },
  );
});

test('the receipt zone-qualifies the table, exactly as the KOT/VOID slips do', () => {
  // The same reasoning as the ticket slips: a label is unique only within a zone,
  // so two tabs can both read "Koshi" — the receipt names the zone to keep them
  // apart. No zone → the bare label, unchanged.
  assert.equal(billToTicket(billDto({ tableLabel: 'Koshi', zone: 'Garden' })).table, 'Koshi · Garden');
  assert.equal(billToTicket(billDto({ tableLabel: 'Koshi', zone: null })).table, 'Koshi');
  assert.equal(billToTicket(billDto({ tableLabel: 'Koshi' })).table, 'Koshi'); // zone absent
});

test('billToTicket carries the fiscal document facts when accounting issued one', () => {
  const t = normalizeTicket(billToTicket(billDto({
    fiscal: {
      docType: 'abbreviated_invoice',
      displayNumber: '2083/84-000042',
      dateBs: '2083-04-24',
      dateAd: '2026-08-09',
      taxablePaisa: 25000,
      payments: [
        { label: 'Cash', amountPaisa: 10000 },
        { label: 'Khalti', amountPaisa: 20750 },
      ],
    },
  })));
  assert.equal(t.fiscal.docTitle, 'ABBREVIATED TAX INVOICE');
  assert.equal(t.fiscal.invoiceNo, '2083/84-000042');
  assert.equal(t.fiscal.dateBs, '2083-04-24');
  assert.equal(t.fiscal.dateAd, '2026-08-09');
  assert.equal(t.fiscal.taxable, 250);
  assert.deepEqual(t.fiscal.payments, [
    { label: 'Cash', amount: 100 },
    { label: 'Khalti', amount: 207.5 },
  ]);
});

test('billToTicket without a fiscal block → a plain receipt (no fiscal on the ticket)', () => {
  const t = normalizeTicket(billToTicket(billDto()));
  assert.equal(t.fiscal, undefined);
});

test('billToTicket prefers exact paisa over the display string for total/discount', () => {
  // If a display string ever disagreed with the paisa, the exact integer wins.
  const t = billToTicket(billDto({ total: 'रू 999.99', totalPaisa: 30750, discount: 'रू 999.99', discountPaisa: 1549 }));
  assert.equal(t.totals.total, 307.5);
  assert.equal(t.totals.discount, 15.49);
});

test('the settle print has copy 0 → revision 0, no copy banner', () => {
  // The original: absent/0 copy keys @0, exactly as before this feature.
  const original = billToTicket(billDto());
  assert.equal(original.revision, 0);
  assert.equal(ticketKey(original), 'bill:99999999-9999-9999-9999-999999999999@0');
  assert.equal(original.copyOf, undefined);
  // An older server that never sends `copy` behaves identically.
  const legacy = billToTicket(billDto({ copy: undefined }));
  assert.equal(legacy.revision, 0);
  assert.equal(legacy.copyOf, undefined);
});

test('a reprint copy becomes the revision → a DISTINCT idempotency key', () => {
  // The whole point: copy N keys @N, so it prints once instead of being dropped
  // as a duplicate of the @0 original.
  const c1 = billToTicket(billDto({ copy: 1 }));
  assert.equal(c1.revision, 1);
  assert.equal(ticketKey(c1), 'bill:99999999-9999-9999-9999-999999999999@1');
  assert.equal(c1.copyOf, 1);

  const c2 = billToTicket(billDto({ copy: 2 }));
  assert.equal(ticketKey(c2), 'bill:99999999-9999-9999-9999-999999999999@2');
  assert.equal(c2.copyOf, 2);
});

test('a non-integer or negative copy is treated as the original (copy 0)', () => {
  // Defensive: only a positive integer bumps the revision; anything else is @0.
  assert.equal(billToTicket(billDto({ copy: -1 })).revision, 0);
  assert.equal(billToTicket(billDto({ copy: 1.5 })).revision, 0);
  assert.equal(billToTicket(billDto({ copy: '3' })).revision, 0);
});

// ── printActionVoidSeed: recovering VOID slips from a snapshot ───────────────

const printedWith = (...ids) => { const s = new Set(ids); return { has: (k) => s.has(k) }; };

test('void-seed prints a VOID slip only when the KOT was printed', () => {
  const voided = dto({ state: 'void', voidReason: 'Table left' });
  const cfg = { stationDelivery: 'print', orderRoutingMode: 'direct' };

  const yes = printActionVoidSeed(voided, cfg, printedWith(voided.orderId));
  assert.equal(yes.action, 'print');
  assert.equal(yes.reason, 'void-seed');
  assert.equal(yes.ticket.voided, true);
  assert.equal(yes.ticket.voidReason, 'Table left');
  assert.equal(ticketKey(yes.ticket).endsWith(':void'), true, 'distinct :void idempotency key');

  const no = printActionVoidSeed(voided, cfg, printedWith());
  assert.equal(no.action, 'skip');
  assert.equal(no.reason, 'void-never-printed');
});

test('void-seed skips a non-void ticket and respects kds-only', () => {
  const cfg = { stationDelivery: 'print', orderRoutingMode: 'direct' };
  assert.equal(printActionVoidSeed(dto({ state: 'preparing' }), cfg, printedWith('x')).reason, 'not-void');
  const voided = dto({ state: 'void' });
  assert.equal(printActionVoidSeed(voided, { stationDelivery: 'kds' }, printedWith(voided.orderId)).reason, 'kds-only');
});

// ── How the bill was paid, on the PLAIN slip ─────────────────────────────────
// snackk now sends `payments` on every settled bill, with or without Accounts.
// These pin the compatibility matrix: new snackk × this agent, old snackk × this
// agent, and a fiscal bill whose tender must print once — from the document.

const cashEsewa = [
  { method: 'cash', label: 'Cash', amount: 'रू 107.50', amountPaisa: 10750 },
  { method: 'esewa', label: 'eSewa', amount: 'रू 200.00', amountPaisa: 20000 },
];

test('billToTicket carries the tender split for the plain slip (no Accounts)', () => {
  const t = normalizeTicket(billToTicket(billDto({ payments: cashEsewa })));
  assert.equal(t.fiscal, undefined);
  assert.deepEqual(t.payments, [
    { label: 'Cash', amount: 107.5 },
    { label: 'eSewa', amount: 200 },
  ]);
  // The tender never touches the print identity — a settle still prints once.
  assert.equal(ticketKey(t), 'bill:99999999-9999-9999-9999-999999999999@0');
});

test('an older snackk that sends no payments → the plain slip is unchanged', () => {
  const t = normalizeTicket(billToTicket(billDto()));
  assert.equal(t.payments, undefined);
  const txt = toText(renderTicket(t));
  assert.doesNotMatch(txt, /Paid/);
});

test('an empty tender list (a fully-comped bill) prints no Paid line', () => {
  const t = normalizeTicket(billToTicket(billDto({ payments: [] })));
  assert.equal(t.payments, undefined);
  assert.doesNotMatch(toText(renderTicket(t)), /Paid/);
});

test('the plain slip prints one "Paid - X" row per tender', () => {
  const txt = toText(renderTicket(normalizeTicket(billToTicket(billDto({ payments: cashEsewa })))));
  assert.match(txt, /Bill #42/);
  assert.match(txt, /Paid - Cash\s+Rs 107\.50/);
  assert.match(txt, /Paid - eSewa\s+Rs 200\.00/);
  assert.doesNotMatch(txt, /TAX INVOICE/);
});

test('a fiscal bill prints its tender ONCE — from the document, never doubled', () => {
  const t = normalizeTicket(billToTicket(billDto({
    payments: cashEsewa,
    fiscal: {
      docType: 'abbreviated_invoice', displayNumber: '2083/84-000042',
      dateBs: '2083-04-24', dateAd: '2026-08-09', taxablePaisa: 25000,
      payments: [
        { label: 'Cash', amountPaisa: 10750 },
        { label: 'eSewa', amountPaisa: 20000 },
      ],
    },
  })));
  const txt = toText(renderTicket(t));
  assert.match(txt, /ABBREVIATED TAX INVOICE/);
  assert.equal(txt.match(/Paid - Cash/g).length, 1);
  assert.equal(txt.match(/Paid - eSewa/g).length, 1);
});

test('a malformed tender row is dropped, never fatal — the receipt still prints', () => {
  const t = normalizeTicket(billToTicket(billDto({
    payments: [null, { label: '', amountPaisa: 100 }, { label: 'Cash', amountPaisa: 30750 }, 'junk'],
  })));
  assert.deepEqual(t.payments, [{ label: 'Cash', amount: 307.5 }]);
  assert.match(toText(renderTicket(t)), /Paid - Cash\s+Rs 307\.50/);
});

// ── tax-invoice format: lines before VAT, addresses, buyer (snackk 6f5a067) ─
// The worked example from snackk docs/INVOICE_FORMAT.md, exactly as snackk's
// bill.print emits it: 2× Momo @350, Tea @120, Thakali @900, VAT-inclusive —
// gross Rs 1,720, taxable Rs 1,522.12. The browser invoice built from this same
// payload is pinned in snackk src/console/billing/printDocument.test.ts.

const exVatLine = (itemName, quantity, gross, rate, amount) => ({
  itemName, quantity, station: 'kitchen', ticketNumber: 1, state: 'served', modifiers: [],
  unitPrice: `Rs ${(gross / quantity).toFixed(2)}`, lineTotal: `Rs ${gross.toFixed(2)}`,
  lineTotalPaisa: Math.round(gross * 100), unitPriceExVat: rate, lineTotalExVat: amount,
});

const invoiceBill = (over = {}) => billDto({
  tableLabel: 'T4', billNumber: 57,
  restaurant: { name: 'Alchemist Online', panNumber: '667677658', address: 'Jhamsikhel-3, Lalitpur' },
  serviceChargeRate: '0.00', vatRate: '13.00', pricesIncludeVat: true,
  lines: [
    exVatLine('Chicken Momo', 2, 700, 'Rs 309.74', 'Rs 619.47'),
    exVatLine('Masala Tea', 1, 120, 'Rs 106.19', 'Rs 106.19'),
    exVatLine('Thakali Set', 1, 900, 'Rs 796.46', 'Rs 796.46'),
  ],
  itemsSubtotal: 'Rs 1,720.00', subtotal: 'Rs 1,522.12', discount: 'Rs 0.00', discountPaisa: 0,
  discountKind: 'none', discountPct: null, discountLabel: null,
  serviceCharge: 'Rs 0.00', taxable: 'Rs 1,522.12', vat: 'Rs 197.88', total: 'Rs 1,720.00', totalPaisa: 172000,
  payments: [{ method: 'cash', label: 'Cash', amount: 'Rs 1,720.00', amountPaisa: 172000 }],
  fiscal: {
    docType: 'tax_invoice', displayNumber: '2083/84-000008', dateBs: '2083-06-27', dateAd: '2026-10-13',
    taxablePaisa: 152212, payments: [{ label: 'Cash', amountPaisa: 172000 }],
    buyerName: null, buyerPan: null, buyerAddress: null,
  },
  ...over,
});

test('lines before VAT map to rate + amount, summing to the subtotal', () => {
  const t = normalizeTicket(billToTicket(invoiceBill()));
  assert.deepEqual(t.items.map((i) => [i.qty, i.name, i.rate, i.amount]), [
    [2, 'Chicken Momo', 309.74, 619.47],
    [1, 'Masala Tea', 106.19, 106.19],
    [1, 'Thakali Set', 796.46, 796.46],
  ]);
  const sum = t.items.reduce((s, i) => s + Math.round(i.amount * 100), 0);
  assert.equal(sum, Math.round(t.totals.subtotal * 100));
  assert.equal(t.totals.taxable, 1522.12);
});

test('the seller block is address then PAN; the menu-price note rides with VAT-inclusive bills', () => {
  const t = normalizeTicket(billToTicket(invoiceBill()));
  assert.deepEqual(t.shopLines, ['Jhamsikhel-3, Lalitpur', 'PAN 667677658']);
  assert.deepEqual(t.notes, ['Menu prices include 13% VAT.']);
  // Exclusive pricing: the lines ARE the menu prices — nothing to explain.
  assert.equal(normalizeTicket(billToTicket(invoiceBill({ pricesIncludeVat: false }))).notes, undefined);
});

test('a full tax invoice asks for all three buyer slots; an abbreviated one does not', () => {
  const full = normalizeTicket(billToTicket(invoiceBill()));
  assert.equal(full.fiscal.buyerSlots, true);
  assert.equal(full.fiscal.buyer, undefined); // nothing given — the slots print blank
  const abbreviated = normalizeTicket(billToTicket(invoiceBill({ fiscal: { ...invoiceBill().fiscal, docType: 'abbreviated_invoice' } })));
  assert.equal(abbreviated.fiscal.buyerSlots, undefined);
  const named = normalizeTicket(billToTicket(invoiceBill({
    fiscal: { ...invoiceBill().fiscal, buyerName: 'Ramesh Thapa', buyerPan: '123456789', buyerAddress: 'Baneshwor' },
  })));
  assert.deepEqual(named.fiscal.buyer, { name: 'Ramesh Thapa', address: 'Baneshwor', pan: '123456789' });
});

test('an older snackk that sends no buyer never prints empty buyer slots', () => {
  // Pre-6f5a067 fiscal block: no buyer keys at all. A real business buyer may
  // exist on that document — blank slots would misstate it.
  const { buyerName: _n, buyerPan: _p, buyerAddress: _a, ...legacyFiscal } = invoiceBill().fiscal;
  const t = normalizeTicket(billToTicket(invoiceBill({ fiscal: legacyFiscal })));
  assert.equal(t.fiscal.buyerSlots, undefined);
});

test('an older snackk (no before-VAT figures) keeps the listed line totals and no rate', () => {
  const t = normalizeTicket(billToTicket(billDto()));
  assert.equal(t.items[0].amount, 265.49);
  assert.equal(t.items[0].rate, undefined);
  assert.equal(t.totals.taxable, undefined);
  assert.deepEqual(t.shopLines, ['PAN 123456789']);
  // Its lines ARE the menu prices (VAT-inclusive here) — no note explaining otherwise.
  assert.equal(t.notes, undefined);
  // Half a pair is treated as absent, never half-applied.
  const half = billToTicket(billDto({ lines: [{ ...billDto().lines[0], lineTotalExVat: 'Rs 200.00' }] }));
  assert.equal(half.items[0].rate, undefined);
  assert.equal(half.items[0].amount, 265.49);
});

test('discount and service-charge labels follow snackk\'s own wording', () => {
  const t = billToTicket(invoiceBill({
    serviceChargeRate: '10.00', discountPaisa: 15221, discountKind: 'percent', discountPct: '10.00', discountLabel: 'Friday Spin',
  }));
  assert.equal(t.discountLabel, 'Friday Spin (10%)');
  assert.equal(t.serviceLabel, 'Service charge (10%)');
  // No discount → no label; the tax invoice's zero row then reads plain "Discount".
  assert.equal(billToTicket(invoiceBill()).discountLabel, undefined);
  assert.equal(billToTicket(invoiceBill({ discountPaisa: 500, discountKind: 'amount' })).discountLabel, 'Discount');
});

test('PARITY: the thermal TAX INVOICE reads row-for-row like the browser invoice', () => {
  // The browser invoice for this payload (snackk printDocument.test.ts), as
  // label/value pairs in print order. The thermal receipt must print the same
  // pairs in the same order — only its typography may differ.
  const browser = [
    ['Invoice no.', '2083/84-000008'],
    ['Date (BS)', '2083-06-27'],
    ['Date (AD)', '2026-10-13'],
    ['Table', 'T4'],
    ['Buyer', ''],
    ['Buyer address', ''],
    ['Buyer PAN', ''],
    ['Chicken Momo', '2 Rs 309.74 Rs 619.47'],
    ['Masala Tea', '1 Rs 106.19 Rs 106.19'],
    ['Thakali Set', '1 Rs 796.46 Rs 796.46'],
    ['Subtotal', 'Rs 1522.12'],
    ['Discount', 'Rs 0.00'],
    ['Taxable amount', 'Rs 1522.12'],
    ['VAT (13%)', 'Rs 197.88'],
    ['Total', 'Rs 1720.00'],
    ['Paid - Cash', 'Rs 1720.00'],
  ];
  const txt = toText(renderTicket(normalizeTicket(billToTicket(invoiceBill()))), { width: 48 });
  const lines = txt.split('\n');
  let at = 0;
  for (const [label, value] of browser) {
    const re = new RegExp(`^${label.replace(/[.()]/g, '\\$&')}\\s*${value.replace(/[.()]/g, '\\$&').replace(/ /g, '\\s+')}\\s*$`, 'i');
    const found = lines.findIndex((l, i) => i >= at && re.test(l.trim()));
    assert.ok(found >= 0, `"${label} ${value}" missing or out of order:\n${txt}`);
    at = found + 1;
  }
  // The header block and notes, in order, above and below.
  assert.ok(txt.indexOf('Jhamsikhel-3, Lalitpur') < txt.indexOf('PAN 667677658'));
  assert.ok(txt.indexOf('PAN 667677658') < txt.indexOf('TAX INVOICE'));
  assert.ok(txt.indexOf('Paid - Cash') < txt.indexOf('Menu prices include 13% VAT.'));
  assert.ok(txt.indexOf('Menu prices include 13% VAT.') < txt.indexOf('Printed on'));
});

test('58mm: the whole tax invoice fits the roll and still reconciles', () => {
  const txt = toText(renderTicket(normalizeTicket(billToTicket(invoiceBill()))), { width: 32 });
  for (const line of txt.split('\n')) assert.ok(line.length <= 32, `overflow: "${line}"`);
  assert.match(txt, /2x Chicken Momo\s+Rs 619\.47\n {3}@ Rs 309\.74/);
  assert.match(txt, /1x Masala Tea\s+Rs 106\.19\n {3}@ Rs 106\.19/); // rate on EVERY line
});
