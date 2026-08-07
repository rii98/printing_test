import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { memoryIdempotency } from '../src/core/idempotency.js';
import { fileIdempotency } from '../src/adapters/store/idempotency-file.js';
import { PrintService } from '../src/core/service.js';
import { PrinterQueue } from '../src/core/queue.js';
import { memoryStore } from '../src/adapters/store/memory.js';
import { fakeTransport } from '../src/adapters/transport/fake.js';

const withTmp = async (fn) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idem-'));
  try { return await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
};

// --- contract: both implementations share identical reserve/rollback semantics ---
const assertReserveContract = (idem) => {
  assert.equal(idem.reserve('k'), true);
  assert.equal(idem.reserve('k'), false, 'second caller loses');
  idem.rollback('k');
  assert.equal(idem.reserve('k'), true, 'rollback frees it for a real retry');
};

test('memory: reserve is atomic single-winner; rollback frees the key', () => {
  assertReserveContract(memoryIdempotency());
});

test('file: reserve is atomic single-winner; rollback frees the key', async () => {
  await withTmp(async (dir) => assertReserveContract(await fileIdempotency(dir)));
});

test('file: committed keys survive a restart (C3)', async () => {
  await withTmp(async (dir) => {
    const a = await fileIdempotency(dir);
    assert.equal(a.reserve('t1@0'), true);
    await a.commit('t1@0');
    const b = await fileIdempotency(dir);                 // fresh process, same dir
    assert.equal(b.reserve('t1@0'), false, 'still known after restart');
  });
});

test('file: a reserved-but-not-committed key is NOT persisted (never lose a print)', async () => {
  await withTmp(async (dir) => {
    const a = await fileIdempotency(dir);
    assert.equal(a.reserve('t2@0'), true);                // "crash" before commit
    const b = await fileIdempotency(dir);
    assert.equal(b.reserve('t2@0'), true, 'an unaccepted ticket can still print after restart');
  });
});

test('file: seed hydrates accepted keys and persists them', async () => {
  await withTmp(async (dir) => {
    const a = await fileIdempotency(dir);
    await a.seed(['s1@0', 's2@0']);
    const b = await fileIdempotency(dir);
    assert.equal(b.reserve('s1@0'), false);
    assert.equal(b.reserve('s2@0'), false);
  });
});

test('file: concurrent commits do not lose keys (serialized atomic writes)', async () => {
  await withTmp(async (dir) => {
    const a = await fileIdempotency(dir);
    const keys = Array.from({ length: 50 }, (_, i) => `c${i}@0`);
    await Promise.all(keys.map((k) => { a.reserve(k); return a.commit(k); }));
    const b = await fileIdempotency(dir);
    for (const k of keys) assert.equal(b.reserve(k), false, `${k} durable`);
  });
});

test('file: a corrupt seen.json is tolerated (starts empty, does not crash)', async () => {
  await withTmp(async (dir) => {
    await fs.writeFile(path.join(dir, 'seen.json'), '{ this is : not json');
    const idem = await fileIdempotency(dir);
    assert.equal(idem.reserve('anything@0'), true);
  });
});

test('file + service: a replay after restart is a duplicate and prints once (C3 e2e)', async () => {
  await withTmp(async (dir) => {
    const ticket = { id: 'o', station: 'kitchen', items: [{ name: 'A', qty: 1 }] };
    const run = async () => {
      const idem = await fileIdempotency(dir);
      const t = fakeTransport();
      const q = new PrinterQueue({ printerId: 'k', transport: t, store: memoryStore(), sleep: () => Promise.resolve() });
      const svc = new PrintService({
        printers: new Map([['k', { queue: q, width: 48, docKind: 'kot' }]]),
        stationToPrinter: { kitchen: 'k' }, idempotency: idem,
      });
      const r = await svc.print(ticket);
      await q.onIdle();
      return { r, sent: t.sent.length };
    };
    const first = await run();
    assert.equal(first.r.status, 'queued');
    assert.equal(first.sent, 1);

    const second = await run();                            // restart, same durable dir
    assert.equal(second.r.status, 'duplicate', 'replay recognized across restart');
    assert.equal(second.sent, 0, 'not reprinted');
  });
});
