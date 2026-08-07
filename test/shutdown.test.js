import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGracefulShutdown } from '../src/shutdown.js';

const fakeLog = () => { const lines = []; return { lines, info: (m) => lines.push(`info ${m}`), warn: (m) => lines.push(`warn ${m}`) }; };
const idleQueue = () => ({ depth: 0, onIdle: () => Promise.resolve() });
const neverIdleQueue = (depth) => ({ depth, onIdle: () => new Promise(() => {}) });

test('drains cleanly within grace and exits 0', async () => {
  const log = fakeLog();
  const exits = [];
  let closed = false;
  const shutdown = createGracefulShutdown({
    server: { close: () => { closed = true; } },
    queues: [idleQueue(), idleQueue()],
    graceMs: 1000, log, exit: (c) => exits.push(c),
  });
  await shutdown('SIGTERM');
  assert.ok(closed, 'server closed');
  assert.deepEqual(exits, [0]);
  assert.ok(log.lines.some((l) => /drained cleanly/.test(l)));
});

test('a stuck queue does not hang shutdown — grace expires and it exits anyway', async () => {
  const log = fakeLog();
  const exits = [];
  const shutdown = createGracefulShutdown({
    queues: [neverIdleQueue(3)],           // offline printer, backoff, never idles
    graceMs: 5000, log,
    exit: (c) => exits.push(c),
    setTimer: (cb) => { cb(); return { unref() {} }; },   // simulate grace elapsed immediately
  });
  await shutdown('SIGTERM');
  assert.deepEqual(exits, [0], 'exits (jobs are durable, resume on restart)');
  assert.ok(log.lines.some((l) => /grace expired — 3 job\(s\)/.test(l)), log.lines.join('|'));
});

test('a second signal forces an immediate exit', async () => {
  const log = fakeLog();
  const exits = [];
  const shutdown = createGracefulShutdown({
    queues: [neverIdleQueue(1)],
    graceMs: 999999, log,
    exit: (c) => exits.push(c),
    setTimer: () => ({ unref() {} }),      // never fires — first call stays pending
  });
  shutdown('SIGINT');                       // starts draining, will not resolve
  await shutdown('SIGINT');                  // second signal
  assert.ok(exits.includes(1), 'forced exit(1) on the second signal');
  assert.ok(log.lines.some((l) => /again — forcing immediate exit/.test(l)));
});

test('missing server is tolerated', async () => {
  const log = fakeLog();
  const exits = [];
  const shutdown = createGracefulShutdown({ queues: [idleQueue()], graceMs: 100, log, exit: (c) => exits.push(c) });
  await shutdown('SIGTERM');
  assert.deepEqual(exits, [0]);
});
