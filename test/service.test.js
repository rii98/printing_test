import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrintService, memoryDedup } from '../src/core/service.js';
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
    dedup: memoryDedup(),
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
