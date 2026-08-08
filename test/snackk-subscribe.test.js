import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscribeStation, subscribeBills, boundedSet } from '../src/inbound/snackk/subscribe.js';

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

/**
 * A Response whose body streams `frames` then HANGS (never closes), like a live
 * SSE link that has gone silent. It honors the fetch AbortSignal — aborting
 * (idle watchdog, connect timeout, or stop()) errors the stream so the pending
 * read rejects, exactly as a real socket abort does. This is what lets the tests
 * exercise the watchdog: a plain closing stream can't, because it never hangs.
 */
function hangingSse(frames, { signal } = {}) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      signal?.addEventListener('abort', () => {
        try { controller.error(new Error('aborted')); } catch { /* already errored */ }
      });
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

test('subscribeBills prints a settled bill on a bill.print event', async () => {
  const bill = {
    sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', tableLabel: 'T2', mergedTables: ['T2'],
    status: 'closed', paid: true, billNumber: 7, restaurant: { name: 'X', panNumber: null },
    openedAt: '2026-08-08T09:00:00Z', closedAt: '2026-08-08T10:00:00Z',
    serviceChargeRate: '10.00', vatRate: '13.00', pricesIncludeVat: true,
    lines: [{ itemName: 'Tea', quantity: 1, station: 'cashier', ticketNumber: 1, state: 'served', modifiers: [], unitPrice: 'रू 50.00', lineTotal: 'रू 50.00' }],
    itemsSubtotal: 'रू 50.00', subtotal: 'रू 44.25', discount: 'रू 0.00', discountPaisa: 0,
    discountKind: 'none', discountPct: null, discountLabel: null,
    serviceCharge: 'रू 4.42', vat: 'रू 6.33', total: 'रू 55.00', totalPaisa: 5500,
  };
  const frames = ['retry: 3000\n\n', `id: 3\nevent: bill.print\ndata: ${JSON.stringify(bill)}\n\n`];
  let calls = 0;
  const fetchImpl = async () => (++calls === 1 ? sseResponse(frames) : { ok: false, status: 499, body: null });

  const printed = [];
  let resolveGot;
  const got = new Promise((r) => { resolveGot = r; });
  const service = { print: async (t) => { printed.push(t); resolveGot(); return { status: 'queued' }; } };

  const sub = subscribeBills({
    baseUrl: 'http://snackk.test', deviceKey: 'k', service,
    getConfig: () => ({ stationDelivery: 'both' }), log: NOLOG, fetchImpl, maxBackoffMs: 10,
  });
  await got;
  sub.stop();
  assert.equal(printed.length, 1);
  assert.equal(printed[0].station, 'cashier');
  assert.equal(printed[0].id, 'bill:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  assert.equal(printed[0].totals.total, 55);
});

test('subscribeBills does not print when the live config is screens-only', async () => {
  const frames = ['retry: 3000\n\n', `id: 1\nevent: bill.print\ndata: {"sessionId":"s","lines":[],"vatRate":"13.00","totalPaisa":100,"discountPaisa":0,"subtotal":"रू 1.00","serviceCharge":"रू 0.00","vat":"रू 0.00"}\n\n`];
  let calls = 0;
  const fetchImpl = async () => (++calls === 1 ? sseResponse(frames) : { ok: false, status: 499, body: null });
  const printed = [];
  const service = { print: async (t) => { printed.push(t); return { status: 'queued' }; } };
  const sub = subscribeBills({
    baseUrl: 'http://snackk.test', deviceKey: 'k', service,
    getConfig: () => ({ stationDelivery: 'kds' }), log: NOLOG, fetchImpl, maxBackoffMs: 10,
  });
  await new Promise((r) => setTimeout(r, 50));
  sub.stop();
  assert.equal(printed.length, 0);
});

test('idle watchdog reconnects when a connected stream goes silent (no heartbeat)', async () => {
  // The classic NAT-death case: the socket delivered one heartbeat then went
  // silent forever with no FIN. Without the watchdog, reader.read() blocks
  // forever and the agent never reconnects. With it, the stream is aborted after
  // idleTimeoutMs and the outer loop opens a fresh connection.
  let streamConnects = 0;
  const fetchImpl = (url, opts) => {
    if (url.endsWith('/active')) return Promise.resolve({ ok: true, json: async () => ({ tickets: [] }) });
    streamConnects += 1;
    return Promise.resolve(hangingSse([': ping\n\n'], opts)); // one ping, then silence
  };
  const sub = subscribeStation({
    baseUrl: 'http://snackk.test', deviceKey: 'k', station: 'kitchen',
    service: { print: async () => ({ status: 'queued' }) },
    getConfig: () => ({ stationDelivery: 'print', orderRoutingMode: 'direct' }),
    printed: new Set(), log: NOLOG, fetchImpl, maxBackoffMs: 5,
    idleTimeoutMs: 25, connectTimeoutMs: 1000, reconcileMs: 1_000_000,
  });
  await new Promise((r) => setTimeout(r, 200));
  sub.stop();
  assert.ok(streamConnects >= 2, `expected reconnect(s) after idle timeout, got ${streamConnects}`);
});

test('connect timeout reconnects when the initial fetch never returns headers', async () => {
  // A half-open proxy accepts the socket but never sends a response. The connect
  // timeout must abort so the loop retries instead of wedging on the open fetch.
  let attempts = 0;
  const fetchImpl = (url, opts) => {
    if (url.endsWith('/active')) return Promise.resolve({ ok: true, json: async () => ({ tickets: [] }) });
    attempts += 1;
    // Never resolves on its own — only the connect-timeout abort rejects it.
    return new Promise((_, reject) => opts.signal?.addEventListener('abort', () => reject(new Error('connect timeout'))));
  };
  const sub = subscribeStation({
    baseUrl: 'http://snackk.test', deviceKey: 'k', station: 'kitchen',
    service: { print: async () => ({ status: 'queued' }) },
    getConfig: () => ({ stationDelivery: 'print', orderRoutingMode: 'direct' }),
    printed: new Set(), log: NOLOG, fetchImpl, maxBackoffMs: 5,
    idleTimeoutMs: 1000, connectTimeoutMs: 20, reconcileMs: 1_000_000,
  });
  await new Promise((r) => setTimeout(r, 150));
  sub.stop();
  assert.ok(attempts >= 2, `expected retries after connect timeout, got ${attempts}`);
});

test('periodic reconcile prints a KOT that appears while the stream stays connected', async () => {
  // The stream is up the whole time (no reconnect), but a KOT was missed — a
  // swallowed publish / dropped frame. It shows up on the board a moment later;
  // the reconcile re-seed must print it without waiting for a reconnect.
  const ticket = {
    orderId: 'o5', sessionId: 's1', tableLabel: 'T1', station: 'kitchen', state: 'preparing',
    ticketNumber: 5, voidReason: null, priority: 0, placedAt: '2026-08-08T10:00:00Z',
    lines: [{ itemName: 'Dal', variantName: null, quantity: 1, modifiers: [], note: null }],
  };
  let boardHasTicket = false;
  let streamConnects = 0;
  const fetchImpl = (url, opts) => {
    if (url.endsWith('/active')) return Promise.resolve({ ok: true, json: async () => ({ tickets: boardHasTicket ? [ticket] : [] }) });
    streamConnects += 1;
    return Promise.resolve(hangingSse([': ping\n\n'], opts)); // connected, then quiet (no reconnect within the window)
  };
  const seen = new Set(); // stand in for the durable idempotency store
  const printed = [];
  const service = {
    print: async (t) => { if (seen.has(t.id)) return { status: 'duplicate' }; seen.add(t.id); printed.push(t); return { status: 'queued' }; },
  };
  const sub = subscribeStation({
    baseUrl: 'http://snackk.test', deviceKey: 'k', station: 'kitchen', service,
    getConfig: () => ({ stationDelivery: 'print', orderRoutingMode: 'direct' }),
    printed: new Set(), log: NOLOG, fetchImpl, maxBackoffMs: 5,
    idleTimeoutMs: 5000, connectTimeoutMs: 1000, reconcileMs: 25,
  });
  await new Promise((r) => setTimeout(r, 60)); // connect-seed ran against an empty board
  assert.equal(printed.length, 0);
  boardHasTicket = true;
  await new Promise((r) => setTimeout(r, 120)); // a reconcile tick seeds the now-present ticket
  sub.stop();
  assert.equal(streamConnects, 1, 'stream must not have reconnected — reconcile alone delivered it');
  assert.equal(printed.length, 1);
  assert.equal(printed[0].id, 'o5');
});

test('status() reports the live link — connected + last event id + seed count', async () => {
  const fetchImpl = (url, opts) => {
    if (url.endsWith('/active')) return Promise.resolve({ ok: true, json: async () => ({ tickets: [] }) });
    return Promise.resolve(hangingSse([`id: 42\nevent: ticket.new\ndata: ${kotDto()}\n\n`], opts));
  };
  let resolveGot;
  const got = new Promise((r) => { resolveGot = r; });
  const service = { print: async () => { resolveGot(); return { status: 'queued' }; } };
  const sub = subscribeStation({
    baseUrl: 'http://snackk.test', deviceKey: 'k', station: 'kitchen', service,
    getConfig: () => ({ stationDelivery: 'print', orderRoutingMode: 'direct' }),
    printed: new Set(), log: NOLOG, fetchImpl, maxBackoffMs: 5,
    idleTimeoutMs: 5000, connectTimeoutMs: 1000, reconcileMs: 1_000_000,
  });
  await got;
  await new Promise((r) => setTimeout(r, 10));
  const s = sub.status();
  sub.stop();
  assert.equal(s.station, 'kitchen');
  assert.equal(s.connected, true);
  assert.equal(s.lastEventId, '42');
  assert.ok(s.seeds >= 1, 'seeded on connect');
  assert.ok(s.idleForMs != null && s.idleForMs >= 0);
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
