import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscribeStation, boundedSet } from '../src/inbound/snackk/subscribe.js';

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

test('seeds the active board on connect, printing a KOT missed while disconnected', async () => {
  // The live stream carries nothing (just its opener) — the fired event scrolled
  // out of the hub buffer while the agent was down. The board snapshot still has
  // the ticket (already bumped to preparing by a cook), so the seed must print it.
  const seedTicket = {
    orderId: 'o9', sessionId: 's1', tableLabel: 'T3', station: 'kitchen', state: 'preparing',
    ticketNumber: 9, voidReason: null, priority: 0, placedAt: '2026-08-08T10:00:00Z',
    lines: [{ itemName: 'Thukpa', variantName: null, quantity: 1, modifiers: [], note: null }],
  };
  let streamCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/active')) return { ok: true, json: async () => ({ mode: 'direct', tickets: [seedTicket] }) };
    // The station stream: open once (empty), then refuse reconnects.
    return ++streamCalls === 1 ? sseResponse(['retry: 3000\n\n']) : { ok: false, status: 499, body: null };
  };

  const printed = [];
  let resolveGot;
  const got = new Promise((r) => { resolveGot = r; });
  const service = { print: async (t) => { printed.push(t); resolveGot(); return { status: 'queued' }; } };

  const sub = subscribeStation({
    baseUrl: 'http://snackk.test', deviceKey: 'k', station: 'kitchen', service,
    getConfig: () => ({ stationDelivery: 'print', orderRoutingMode: 'direct' }),
    printed: new Set(), log: NOLOG, fetchImpl, maxBackoffMs: 10,
  });

  await got;
  sub.stop();
  assert.equal(printed.length, 1);
  assert.equal(printed[0].id, 'o9');
  assert.equal(printed[0].items[0].name, 'Thukpa');
});

test('boundedSet evicts the oldest beyond its limit', () => {
  const s = boundedSet(2);
  s.add('a'); s.add('b');
  assert.ok(s.has('a') && s.has('b'));
  s.add('c'); // evicts 'a'
  assert.equal(s.has('a'), false);
  assert.ok(s.has('b') && s.has('c'));
  assert.equal(s.size(), 2);
  s.add('b'); // a re-add is a no-op, never grows or reorders
  assert.equal(s.size(), 2);
});
