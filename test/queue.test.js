import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrinterQueue, backoff } from '../src/core/queue.js';
import { memoryStore } from '../src/adapters/store/memory.js';
import { fakeTransport } from '../src/adapters/transport/fake.js';

const noSleep = () => Promise.resolve();
const bytesOf = (s) => Buffer.from(s, 'utf8');

function makeQueue(transport, store, opts = {}) {
  const events = [];
  const q = new PrinterQueue({
    printerId: 'p', transport, store, sleep: noSleep,
    onEvent: (e) => events.push(e), policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 }, ...opts,
  });
  return { q, events };
}

test('happy path: sends and clears the store', async () => {
  const store = memoryStore(); const t = fakeTransport();
  const { q, events } = makeQueue(t, store);
  await q.enqueue({ id: 'j1', bytes: bytesOf('hello') });
  await q.onIdle();
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].toString(), 'hello');
  assert.equal((await store.list()).length, 0, 'store cleared after success');
  assert.ok(events.some((e) => e.type === 'sent'));
});

test('FIFO order preserved', async () => {
  const store = memoryStore(); const t = fakeTransport();
  const { q } = makeQueue(t, store);
  await q.enqueue({ id: 'a', bytes: bytesOf('1') });
  await q.enqueue({ id: 'b', bytes: bytesOf('2') });
  await q.enqueue({ id: 'c', bytes: bytesOf('3') });
  await q.onIdle();
  assert.deepEqual(t.sent.map((b) => b.toString()), ['1', '2', '3']);
});

test('transient failures retry, then succeed', async () => {
  const store = memoryStore(); const t = fakeTransport({ failFirst: 2 });
  const { q, events } = makeQueue(t, store, { policy: { maxAttempts: 8, baseDelayMs: 1, maxDelayMs: 1 } });
  await q.enqueue({ id: 'j', bytes: bytesOf('x') });
  await q.onIdle();
  assert.equal(t.sent.length, 1, 'eventually printed');
  assert.equal(events.filter((e) => e.type === 'retry').length, 2);
});

test('dead-letters after maxAttempts, keeps the job, moves on', async () => {
  const store = memoryStore(); const t = fakeTransport({ online: false });
  const { q, events } = makeQueue(t, store);
  await q.enqueue({ id: 'dead1', bytes: bytesOf('x') });
  await q.onIdle();
  assert.equal(t.sent.length, 0);
  assert.equal((await store.list()).length, 0, 'not left pending');
  assert.equal((await store.listDead()).length, 1, 'preserved in dead-letter');
  assert.ok(events.some((e) => e.type === 'offline'));
  assert.ok(events.some((e) => e.type === 'dead'));
  assert.equal(q.healthy, false);
});

test('durability: a job persisted before a crash is recovered and printed', async () => {
  const store = memoryStore();
  // Simulate a crash: the job was persisted but never sent.
  await store.add({ id: 'survivor', key: 'survivor', printerId: 'p', bytes: bytesOf('recovered').toString('base64'), attempts: 0, createdAt: 1 });
  const t = fakeTransport();
  const { q } = makeQueue(t, store);
  await q.recover();
  await q.onIdle();
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].toString(), 'recovered');
  assert.equal((await store.list()).length, 0);
});

test('recovery from OFFLINE to ONLINE emits health transitions', async () => {
  const store = memoryStore(); const t = fakeTransport({ failFirst: 2 });
  const { q, events } = makeQueue(t, store, { policy: { maxAttempts: 8, baseDelayMs: 1, maxDelayMs: 1 } });
  await q.enqueue({ id: 'j', bytes: bytesOf('x') });
  await q.onIdle();
  assert.ok(events.some((e) => e.type === 'offline'));
  assert.ok(events.some((e) => e.type === 'online'));
});

test('backoff is bounded by maxDelay and non-negative', () => {
  for (let a = 1; a <= 12; a++) {
    const d = backoff(a, { baseDelayMs: 500, maxDelayMs: 30000 }, () => 1);
    assert.ok(d >= 0 && d <= 30000);
  }
});
