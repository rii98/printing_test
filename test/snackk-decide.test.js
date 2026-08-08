import { test } from 'node:test';
import assert from 'node:assert/strict';
import { printAction } from '../src/inbound/snackk/map.js';

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
