import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTicket, ticketKey, ValidationError } from '../src/core/domain.js';

const base = { id: 'o1', station: 'kitchen', items: [{ name: 'Momo', qty: 1 }] };

test('revision defaults to 0 when absent', () => {
  assert.equal(normalizeTicket({ ...base }).revision, 0);
});

test('a valid non-negative integer revision is kept', () => {
  assert.equal(normalizeTicket({ ...base, revision: 3 }).revision, 3);
});

test('a fractional revision is rejected (not silently floored to 0)', () => {
  assert.throws(() => normalizeTicket({ ...base, revision: 1.5 }), ValidationError);
});

test('a negative revision is rejected', () => {
  assert.throws(() => normalizeTicket({ ...base, revision: -1 }), ValidationError);
});

test('a non-numeric revision is rejected (would have collapsed to 0 before)', () => {
  // Regression for the real hazard: "2" used to become revision 0, so a genuine
  // edit of an already-printed ticket would be dropped as a duplicate.
  assert.throws(() => normalizeTicket({ ...base, revision: '2' }), ValidationError);
});

test('distinct integer revisions produce distinct idempotency keys', () => {
  const k0 = ticketKey(normalizeTicket({ ...base, revision: 0 }));
  const k1 = ticketKey(normalizeTicket({ ...base, revision: 1 }));
  assert.notEqual(k0, k1);
});

test('number: valid integer kept, absent stays undefined, invalid rejected', () => {
  assert.equal(normalizeTicket({ ...base, number: 12 }).number, 12);
  assert.equal(normalizeTicket({ ...base }).number, undefined);
  assert.throws(() => normalizeTicket({ ...base, number: 12.5 }), ValidationError);
  assert.throws(() => normalizeTicket({ ...base, number: -3 }), ValidationError);
});
