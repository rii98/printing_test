import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fireState,
  isPrintFire,
  isVoid,
  orderTicketToTicket,
  parseNpr,
  billToTicket,
} from '../src/inbound/snackk/map.js';
import { normalizeTicket, ticketKey } from '../src/core/domain.js';
import { computeTotals } from '../src/core/render/layouts/bill.js';

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
  assert.equal(t.taxLabel, 'VAT 13%');
  // The trusted breakdown is exactly snackk's — discount/total from exact paisa.
  const c = computeTotals(t);
  assert.deepEqual(
    { subtotal: c.subtotal, discount: c.discount, service: c.service, tax: c.tax, total: c.total },
    { subtotal: 265.49, discount: 15.49, service: 25, tax: 32.5, total: 307.5 },
  );
});

test('billToTicket prefers exact paisa over the display string for total/discount', () => {
  // If a display string ever disagreed with the paisa, the exact integer wins.
  const t = billToTicket(billDto({ total: 'रू 999.99', totalPaisa: 30750, discount: 'रू 999.99', discountPaisa: 1549 }));
  assert.equal(t.totals.total, 307.5);
  assert.equal(t.totals.discount, 15.49);
});
