import { test } from 'node:test';
import assert from 'node:assert/strict';
import { printAction, printActionSeed, printActionLineVoid, lineVoidChitToTicket } from '../src/inbound/snackk/map.js';
import { ticketKey } from '../src/core/domain.js';

const dto = (over = {}) => ({
  orderId: 'o1', station: 'kitchen', state: 'received', ticketNumber: 1,
  tableLabel: 'T1', placedAt: '2026-08-08T10:00:00Z',
  lines: [{ itemName: 'Momo', variantName: null, quantity: 1, modifiers: [], note: null }],
  voidReason: null, ...over,
});
const CFG = { stationDelivery: 'print', orderRoutingMode: 'direct' };

test('KDS-only delivery prints nothing', () => {
  const d = printAction(dto(), { ...CFG, stationDelivery: 'kds' }, new Set());
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'kds-only');
});

test('both mode prints a fired ticket', () => {
  const d = printAction(dto(), { ...CFG, stationDelivery: 'both' }, new Set());
  assert.equal(d.action, 'print');
  assert.equal(d.reason, 'fire');
  assert.equal(d.firstPrint, true);
  assert.equal(d.ticket.id, 'o1');
});

test('direct mode prints on received; a later bump does not', () => {
  assert.equal(printAction(dto({ state: 'received' }), CFG, new Set()).action, 'print');
  assert.equal(printAction(dto({ state: 'preparing' }), CFG, new Set()).action, 'skip');
});

test('waiter_confirm does not print the unconfirmed received ticket', () => {
  const wc = { ...CFG, orderRoutingMode: 'waiter_confirm' };
  assert.equal(printAction(dto({ state: 'received' }), wc, new Set()).action, 'skip');
  assert.equal(printAction(dto({ state: 'confirmed' }), wc, new Set()).action, 'print');
});

test('a void prints a slip only if the KOT was already printed', () => {
  const unprinted = printAction(dto({ state: 'void' }), CFG, new Set());
  assert.equal(unprinted.action, 'skip');
  assert.equal(unprinted.reason, 'void-never-printed');

  const printed = new Set(['o1']);
  const d = printAction(dto({ state: 'void', voidReason: 'guest left' }), CFG, printed);
  assert.equal(d.action, 'print');
  assert.equal(d.reason, 'void');
  assert.equal(d.ticket.voided, true);
});

test('seed prints any board ticket (even a bumped one), gated on delivery mode', () => {
  // A board ticket is at or past its fire state, so seed prints it regardless of
  // state — this is how a KOT missed while disconnected (already bumped to
  // preparing by a human) still comes out. The durable store dedupes a re-seed.
  const received = printActionSeed(dto({ state: 'received' }), CFG, new Set());
  assert.equal(received.action, 'print');
  assert.equal(received.reason, 'seed');
  assert.equal(received.firstPrint, true);

  const bumped = printActionSeed(dto({ state: 'preparing' }), CFG, new Set());
  assert.equal(bumped.action, 'print', 'a bumped board ticket the agent never printed is a missed KOT');

  const kds = printActionSeed(dto(), { ...CFG, stationDelivery: 'kds' }, new Set());
  assert.equal(kds.action, 'skip');
  assert.equal(kds.reason, 'kds-only');
});

// ---- line-void pull chits (a partial void; the order stays live) ----

const chit = (over = {}) => ({
  orderId: 'o1', ticketNumber: 7, station: 'kitchen', tableLabel: 'T3',
  placedAt: '2026-08-08T10:00:00Z', reason: 'Wrong item',
  lines: [{ id: 'L9', itemName: 'Momo', variantName: 'Full', quantity: 2, modifiers: [], note: null }],
  ...over,
});

test('a pull chit prints a VOID slip only if the KOT was already printed', () => {
  const unprinted = printActionLineVoid(chit(), CFG, new Set());
  assert.equal(unprinted.action, 'skip');
  assert.equal(unprinted.reason, 'linevoid-never-printed');

  const d = printActionLineVoid(chit(), CFG, new Set(['o1']));
  assert.equal(d.action, 'print');
  assert.equal(d.reason, 'line-void');
  assert.equal(d.ticket.voided, true);
  assert.equal(d.ticket.items[0].name, 'Momo (Full)');
  assert.equal(d.ticket.items[0].voided, true);
  assert.equal(d.ticket.voidReason, 'Wrong item');
});

test('a pull chit never prints under KDS-only delivery', () => {
  const d = printActionLineVoid(chit(), { ...CFG, stationDelivery: 'kds' }, new Set(['o1']));
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'kds-only');
});

test('a pull chit prints even with no reason (a frictionless guest self-cancel)', () => {
  const d = printActionLineVoid(chit({ reason: null }), CFG, new Set(['o1']));
  assert.equal(d.action, 'print');
  assert.equal(d.ticket.voidReason, undefined);
});

test('a pull chit idempotency key is per-LINE, distinct from the whole-ticket void', () => {
  // The line chit and a later whole-ticket void of the same order must not
  // collapse onto one key, or the second slip would be dropped as a duplicate.
  const lineKey = ticketKey(lineVoidChitToTicket(chit()));
  assert.equal(lineKey, 'o1:L9@0:void');

  const otherLine = ticketKey(lineVoidChitToTicket(chit({ lines: [{ id: 'L10', itemName: 'Dal', variantName: null, quantity: 1, modifiers: [], note: null }] })));
  assert.equal(otherLine, 'o1:L10@0:void');
  assert.notEqual(lineKey, otherLine);            // two pulls on one ticket stay distinct
  assert.notEqual(lineKey, 'o1@0:void');          // never the order-level void key
});
