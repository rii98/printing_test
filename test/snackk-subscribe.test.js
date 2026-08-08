import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscribeStation } from '../src/inbound/snackk/subscribe.js';

const NOLOG = { info() {}, warn() {} };

/** A fetch Response whose body streams the given SSE frames, then closes. */
function sseResponse(frames) {
  const body = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return { ok: true, body };
}

const kotDto = (over = {}) => JSON.stringify({
  orderId: 'o1', sessionId: 's1', tableLabel: 'T1', station: 'kitchen', state: 'received',
  ticketNumber: 1, voidReason: null, priority: 0, placedAt: '2026-08-08T10:00:00Z',
  lines: [{ itemName: 'Momo', variantName: null, quantity: 2, modifiers: [], note: null }], ...over,
});

test('subscribes, maps a fired ticket, and calls service.print', async () => {
  const frames = ['retry: 3000\n\n', `id: 5\nevent: ticket.new\ndata: ${kotDto()}\n\n`];
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    // First connect streams the frames; any reconnect can't re-open (we stop()).
    return calls === 1 ? sseResponse(frames) : { ok: false, status: 499, body: null };
  };

  const printed = [];
  let resolveGot;
  const got = new Promise((r) => { resolveGot = r; });
  const service = {
    print: async (t) => { printed.push(t); resolveGot(); return { status: 'queued' }; },
  };

  const sub = subscribeStation({
    baseUrl: 'http://snackk.test', deviceKey: 'k', station: 'kitchen', service,
    getConfig: () => ({ stationDelivery: 'print', orderRoutingMode: 'direct' }),
    printed: new Set(), log: NOLOG, fetchImpl, maxBackoffMs: 10,
  });

  await got;
  sub.stop();

  assert.equal(printed.length, 1);
  assert.equal(printed[0].id, 'o1');
  assert.equal(printed[0].station, 'kitchen');
  assert.equal(printed[0].number, 1);
  assert.equal(printed[0].items[0].name, 'Momo');
  assert.equal(printed[0].items[0].qty, 2);
});

test('does not print when the config is KDS-only', async () => {
  const frames = ['retry: 3000\n\n', `id: 1\nevent: ticket.new\ndata: ${kotDto()}\n\n`, 'id: 2\nevent: ticket.updated\ndata: ' + kotDto({ state: 'preparing' }) + '\n\n'];
  let calls = 0;
  const fetchImpl = async () => (++calls === 1 ? sseResponse(frames) : { ok: false, status: 499, body: null });
  const printed = [];
  const service = { print: async (t) => { printed.push(t); return { status: 'queued' }; } };

  const sub = subscribeStation({
    baseUrl: 'http://snackk.test', deviceKey: 'k', station: 'kitchen', service,
    getConfig: () => ({ stationDelivery: 'kds', orderRoutingMode: 'direct' }),
    printed: new Set(), log: NOLOG, fetchImpl, maxBackoffMs: 10,
  });

  // Let the (closed) stream drain fully, then assert nothing printed.
  await new Promise((r) => setTimeout(r, 50));
  sub.stop();
  assert.equal(printed.length, 0);
});
