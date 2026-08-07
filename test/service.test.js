import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrintService } from '../src/core/service.js';
import { memoryIdempotency } from '../src/core/idempotency.js';
import { PrinterQueue } from '../src/core/queue.js';
import { memoryStore } from '../src/adapters/store/memory.js';
import { fakeTransport } from '../src/adapters/transport/fake.js';

function buildService() {
  const transports = { cashier: fakeTransport(), kitchen: fakeTransport() };
  const printers = new Map();
  for (const [station, id] of [['cashier', 'cashier'], ['kitchen', 'kitchen']]) {
    const queue = new PrinterQueue({ printerId: id, transport: transports[station], store: memoryStore(), sleep: () => Promise.resolve() });
    printers.set(id, { queue, width: 48, docKind: station === 'cashier' ? 'bill' : 'kot' });
  }
  const service = new PrintService({
    printers,
    stationToPrinter: { cashier: 'cashier', kitchen: 'kitchen' },
    branding: { shopName: 'TEST' },
    idempotency: memoryIdempotency(),
  });
  return { service, transports, printers };
}

test('routes a kitchen ticket to the kitchen printer only', async () => {
  const { service, printers, transports } = buildService();
  const r = await service.print({ id: 'o1', station: 'kitchen', items: [{ name: 'Momo', qty: 2 }] });
  assert.equal(r.status, 'queued');
  assert.equal(r.printer, 'kitchen');
  await printers.get('kitchen').queue.onIdle();
  assert.equal(transports.kitchen.sent.length, 1);
  assert.equal(transports.cashier.sent.length, 0);
});

test('idempotent: same id@revision prints once', async () => {
  const { service, printers, transports } = buildService();
  const ticket = { id: 'o2', revision: 0, station: 'kitchen', items: [{ name: 'Tea', qty: 1 }] };
  const a = await service.print(ticket);
  const b = await service.print(ticket);          // replay
  assert.equal(a.status, 'queued');
  assert.equal(b.status, 'duplicate');
  await printers.get('kitchen').queue.onIdle();
  assert.equal(transports.kitchen.sent.length, 1);
});

test('concurrent identical requests print exactly once (C1 race)', async () => {
  const { service, printers, transports } = buildService();
  const ticket = { id: 'race1', station: 'kitchen', items: [{ name: 'Momo', qty: 1 }] };
  // Fire many identical requests at once — an SSE replay / POS retry storm.
  const results = await Promise.all(Array.from({ length: 25 }, () => service.print({ ...ticket })));
  await printers.get('kitchen').queue.onIdle();
  const queued = results.filter((r) => r.status === 'queued').length;
  const duplicate = results.filter((r) => r.status === 'duplicate').length;
  assert.equal(queued, 1, 'exactly one request is accepted');
  assert.equal(duplicate, 24, 'the rest are recognized as duplicates');
  assert.equal(transports.kitchen.sent.length, 1, 'exactly one receipt on paper');
});

test('a failed enqueue rolls back the reservation so a retry can print', async () => {
  let fail = true;
  const queue = {
    healthy: true, depth: 0, transport: { describe: 'fake' },
    async enqueue(job) { if (fail) { fail = false; throw new Error('store add failed'); } this.transport.sent.push(job); },
  };
  queue.transport.sent = [];
  const service = new PrintService({
    printers: new Map([['kitchen', { queue, width: 48, docKind: 'kot' }]]),
    stationToPrinter: { kitchen: 'kitchen' },
    idempotency: memoryIdempotency(),
  });
  const ticket = { id: 'rb1', station: 'kitchen', items: [{ name: 'Tea', qty: 1 }] };
  const first = await service.print({ ...ticket });
  assert.equal(first.status, 'error', 'first attempt surfaces the enqueue failure');
  const second = await service.print({ ...ticket });   // same key, must NOT be swallowed as duplicate
  assert.equal(second.status, 'queued', 'retry of a never-accepted ticket goes through');
  assert.equal(queue.transport.sent.length, 1);
});

test('a render/encode failure rolls back the key (never a phantom duplicate)', async () => {
  // A printer whose encoding is invalid makes encode() throw AFTER the key is
  // reserved but BEFORE enqueue. The reservation must be released so the caller
  // gets an honest error and a corrected retry can still print — the ticket must
  // never be stranded as an un-printable "duplicate".
  const transport = fakeTransport();
  const queue = new PrinterQueue({ printerId: 'cashier', transport, store: memoryStore(), sleep: () => Promise.resolve() });
  const service = new PrintService({
    printers: new Map([['cashier', { queue, width: 48, encoding: 'not-a-real-encoding', docKind: 'bill' }]]),
    stationToPrinter: { cashier: 'cashier' },
    idempotency: memoryIdempotency(),
  });
  const ticket = { id: 'enc1', station: 'cashier', items: [{ name: 'Coffee', qty: 1, price: 3.5 }] };

  const first = await service.print({ ...ticket });
  assert.equal(first.status, 'error', 'encode failure surfaces as an error, not a rejected promise');
  assert.match(first.error, /encoding/i);
  assert.equal(transport.sent.length, 0, 'nothing reached the printer');

  // Same key again: because the reservation was rolled back, this is NOT a duplicate.
  const second = await service.print({ ...ticket });
  assert.equal(second.status, 'error', 'still the same encode fault, but still retryable');
  assert.notEqual(second.status, 'duplicate', 'the key was freed — never stranded');
});

test('a new revision prints again', async () => {
  const { service, printers, transports } = buildService();
  await service.print({ id: 'o3', revision: 0, station: 'kitchen', items: [{ name: 'A', qty: 1 }] });
  const r = await service.print({ id: 'o3', revision: 1, station: 'kitchen', items: [{ name: 'A', qty: 1 }, { name: 'B', qty: 1 }] });
  assert.equal(r.status, 'queued');
  await printers.get('kitchen').queue.onIdle();
  assert.equal(transports.kitchen.sent.length, 2);
});

test('invalid ticket is rejected, not queued', async () => {
  const { service } = buildService();
  assert.equal((await service.print({ id: '', station: 'kitchen', items: [] })).status, 'error');
  assert.equal((await service.print({ id: 'x', station: 'moon', items: [{ name: 'a' }] })).status, 'error');
  assert.equal((await service.print({ id: 'x', station: 'kitchen', items: [] })).status, 'error');
});

test('unknown station with no printer returns a clear error', async () => {
  const { service } = buildService();
  // 'bar' is a valid station but no bar printer is configured here.
  const r = await service.print({ id: 'o4', station: 'bar', items: [{ name: 'Beer', qty: 1 }] });
  assert.equal(r.status, 'error');
  assert.match(r.error, /no printer configured for station "bar"/);
});

test('health reports depth + transport per printer', () => {
  const { service } = buildService();
  const h = service.health();
  assert.ok(h.printers.cashier);
  assert.equal(typeof h.printers.kitchen.depth, 'number');
});
