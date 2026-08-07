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
