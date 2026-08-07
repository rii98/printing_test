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

test('a reachable printer that keeps rejecting dead-letters after maxAttempts', async () => {
  // The printer is up (we connect) but rejects every transfer — a poison job.
  // It must exhaust its budget and dead-letter so the line can move on.
  const store = memoryStore(); const t = fakeTransport({ rejectWrites: true });
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

test('M2: an outage never dead-letters — jobs are held and print when the printer returns', async () => {
  const store = memoryStore();
  const t = fakeTransport({ online: false });   // unreachable -> kind:'offline'
  // Deterministically bring the printer back after several offline retries — well
  // past maxAttempts (3), proving the outage did NOT consume the dead-letter budget.
  let retries = 0;
  const sleep = () => { if (++retries === 6) t.online = true; return Promise.resolve(); };
  const { q, events } = makeQueue(t, store, { sleep });

  await q.enqueue({ id: 'a', bytes: bytesOf('1') });
  await q.enqueue({ id: 'b', bytes: bytesOf('2') });
  await q.onIdle();

  assert.deepEqual(t.sent.map((b) => b.toString()), ['1', '2'], 'both printed, in order, once back');
  assert.equal(events.filter((e) => e.type === 'dead').length, 0, 'nothing dead-lettered during the outage');
  assert.equal((await store.listDead()).length, 0);
  assert.equal((await store.list()).length, 0, 'queue fully drained');
  assert.ok(retries > 3, 'retried more times than maxAttempts without dead-lettering');
  assert.ok(events.some((e) => e.type === 'offline'), 'reported OFFLINE');
  assert.ok(events.some((e) => e.type === 'online'), 'reported back ONLINE');
});

test('M2 safety: an UNCLASSIFIED (untagged) failure still dead-letters, never loops forever', async () => {
  // A fault with no kind (e.g. a corrupt payload) must be treated as a hard
  // failure, not mistaken for an outage — otherwise it would block the queue.
  const store = memoryStore();
  const t = { describe: 'x', async send() { throw new Error('mystery failure'); }, async probe() { return false; } };
  const { q, events } = makeQueue(t, store);         // maxAttempts: 3
  await q.enqueue({ id: 'poison', bytes: bytesOf('x') });
  await q.onIdle();                                    // must resolve, not hang
  assert.equal((await store.listDead()).length, 1, 'dead-lettered after the cap');
  assert.ok(events.some((e) => e.type === 'dead'));
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

test('C2: a store error AFTER a successful send does not re-send the job', async () => {
  const store = memoryStore();
  store.remove = async () => { throw new Error('EIO on remove'); };  // bookkeeping fails post-send
  const t = fakeTransport();
  const { q, events } = makeQueue(t, store);
  await q.enqueue({ id: 'j1', bytes: bytesOf('receipt') });
  await q.onIdle();
  assert.equal(t.sent.length, 1, 'printed exactly once — a bookkeeping error must not re-send');
  assert.ok(events.some((e) => e.type === 'sent'), 'job counts as sent');
  assert.ok(!events.some((e) => e.type === 'retry' || e.type === 'offline'), 'not misclassified as a delivery failure');
  assert.ok(events.some((e) => e.type === 'store-error' && e.op === 'remove'), 'store failure surfaced');
  assert.equal(q.healthy, true);
});

test('C2: a TRANSIENT remove failure does not cause a duplicate on restart', async () => {
  const store = memoryStore();
  const realRemove = store.remove;
  let failOnce = true;
  store.remove = async (id) => { if (failOnce) { failOnce = false; throw new Error('transient EIO'); } return realRemove(id); };

  const t1 = fakeTransport();
  const { q: q1 } = makeQueue(t1, store);
  await q1.enqueue({ id: 'j1', bytes: bytesOf('receipt') });
  await q1.onIdle();
  assert.equal(t1.sent.length, 1, 'printed once in run 1');
  assert.equal((await store.list()).length, 0, 'pending record actually cleared (remove was retried)');

  // Simulate a restart: a fresh queue recovers from the same store.
  const t2 = fakeTransport();
  const { q: q2 } = makeQueue(t2, store);
  await q2.recover();
  await q2.onIdle();
  assert.equal(t2.sent.length, 0, 'nothing left to reprint after restart');
});

test('C2: a store error while persisting a retry never crashes the drain loop', async () => {
  const store = memoryStore();
  store.update = async () => { throw new Error('EIO on update'); };
  const t = fakeTransport({ failFirst: 2 });
  const { q, events } = makeQueue(t, store, { policy: { maxAttempts: 8, baseDelayMs: 1, maxDelayMs: 1 } });
  await q.enqueue({ id: 'j', bytes: bytesOf('x') });
  await q.onIdle();                                   // must resolve, not hang or crash
  assert.equal(t.sent.length, 1, 'eventually printed despite update failures');
  assert.ok(events.some((e) => e.type === 'store-error' && e.op === 'update'));
});

test('C2: a throwing event consumer never breaks delivery', async () => {
  const store = memoryStore();
  const t = fakeTransport();
  const q = new PrinterQueue({
    printerId: 'p', transport: t, store, sleep: noSleep,
    onEvent: () => { throw new Error('observer blew up'); },
    policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
  });
  await q.enqueue({ id: 'j', bytes: bytesOf('x') });
  await q.onIdle();
  assert.equal(t.sent.length, 1, 'delivery is independent of observer failures');
});

test('backoff is bounded by maxDelay and non-negative', () => {
  for (let a = 1; a <= 12; a++) {
    const d = backoff(a, { baseDelayMs: 500, maxDelayMs: 30000 }, () => 1);
    assert.ok(d >= 0 && d <= 30000);
  }
});
