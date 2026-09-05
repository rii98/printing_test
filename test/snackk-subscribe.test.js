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
    if (url.includes('/line-voids/recent')) return { ok: true, json: async () => ({ chits: [] }) };
    if (url.includes('/voids/recent')) return { ok: true, json: async () => ({ tickets: [] }) };
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
    if (url.includes('/line-voids/recent')) return Promise.resolve({ ok: true, json: async () => ({ chits: [] }) });
    if (url.includes('/voids/recent')) return Promise.resolve({ ok: true, json: async () => ({ tickets: [] }) });
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
    if (url.includes('/line-voids/recent')) return Promise.resolve({ ok: true, json: async () => ({ chits: [] }) });
    if (url.includes('/voids/recent')) return Promise.resolve({ ok: true, json: async () => ({ tickets: [] }) });
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
    if (url.includes('/line-voids/recent')) return Promise.resolve({ ok: true, json: async () => ({ chits: [] }) });
    if (url.includes('/voids/recent')) return Promise.resolve({ ok: true, json: async () => ({ tickets: [] }) });
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

// ── recovery: VOID slips and settled bills survive a restart/offline window ──

test('subscribeStation recovers a VOID slip from the snapshot when the KOT was printed', async () => {
  // The void fired while the agent was offline: it never hit a board (terminal),
  // so the active-seed can't replay it. The voids snapshot re-exposes it; the slip
  // prints because the durable-backed `printed` says the KOT did print.
  const voided = {
    orderId: 'ov', sessionId: 's1', tableLabel: 'T2', station: 'kitchen', state: 'void',
    ticketNumber: 4, voidReason: 'Sent back', priority: 0, placedAt: '2026-08-08T10:00:00Z', lines: [],
  };
  const fetchImpl = (url, opts) => {
    if (url.endsWith('/active')) return Promise.resolve({ ok: true, json: async () => ({ tickets: [] }) });
    if (url.includes('/line-voids/recent')) return Promise.resolve({ ok: true, json: async () => ({ chits: [] }) });
    if (url.includes('/voids/recent')) return Promise.resolve({ ok: true, json: async () => ({ tickets: [voided] }) });
    return Promise.resolve(hangingSse([': ping\n\n'], opts));
  };
  const printed = [];
  const service = { print: async (t) => { printed.push(t); return { status: 'queued' }; } };
  const sub = subscribeStation({
    baseUrl: 'http://snackk.test', deviceKey: 'k', station: 'kitchen', service,
    getConfig: () => ({ stationDelivery: 'print', orderRoutingMode: 'direct' }),
    printed: { has: () => true, add: () => {} }, // durable store: the KOT was printed
    log: NOLOG, fetchImpl, maxBackoffMs: 5, idleTimeoutMs: 5000, reconcileMs: 1_000_000,
  });
  await new Promise((r) => setTimeout(r, 60));
  sub.stop();
  assert.equal(printed.length, 1);
  assert.equal(printed[0].id, 'ov');
  assert.equal(printed[0].voided, true);
  assert.equal(printed[0].voidReason, 'Sent back');
});

test('subscribeStation does NOT recover a void whose KOT it never printed', async () => {
  const voided = {
    orderId: 'ov2', sessionId: 's1', tableLabel: 'T2', station: 'kitchen', state: 'void',
    ticketNumber: 5, voidReason: null, priority: 0, placedAt: '2026-08-08T10:00:00Z', lines: [],
  };
  const fetchImpl = (url, opts) => {
    if (url.endsWith('/active')) return Promise.resolve({ ok: true, json: async () => ({ tickets: [] }) });
    if (url.includes('/line-voids/recent')) return Promise.resolve({ ok: true, json: async () => ({ chits: [] }) });
    if (url.includes('/voids/recent')) return Promise.resolve({ ok: true, json: async () => ({ tickets: [voided] }) });
    return Promise.resolve(hangingSse([': ping\n\n'], opts));
  };
  const printed = [];
  const service = { print: async (t) => { printed.push(t); return { status: 'queued' }; } };
  const sub = subscribeStation({
    baseUrl: 'http://snackk.test', deviceKey: 'k', station: 'kitchen', service,
    getConfig: () => ({ stationDelivery: 'print', orderRoutingMode: 'direct' }),
    printed: { has: () => false, add: () => {} }, // never printed the KOT → no slip
    log: NOLOG, fetchImpl, maxBackoffMs: 5, idleTimeoutMs: 5000, reconcileMs: 1_000_000,
  });
  await new Promise((r) => setTimeout(r, 60));
  sub.stop();
  assert.equal(printed.length, 0);
});

test('subscribeBills recovers a settled bill from the snapshot on connect', async () => {
  // A bill settled while the agent was offline: bill.print went to a channel with
  // no subscriber and is gone. The recovery snapshot re-exposes it on reconnect.
  const bill = {
    sessionId: 'sb', tableLabel: 'T9', status: 'closed', billNumber: 7,
    closedAt: '2026-08-08T10:00:00Z', vatRate: '13.00',
    lines: [{ itemName: 'Momo', quantity: 1, lineTotal: 'रू 100.00' }],
    subtotal: 'रू 100.00', discount: 'रू 0.00', serviceCharge: 'रू 10.00', vat: 'रू 13.00', total: 'रू 123.00',
  };
  const fetchImpl = (url, opts) => {
    if (url.includes('/bills/recent')) return Promise.resolve({ ok: true, json: async () => ({ bills: [bill] }) });
    return Promise.resolve(hangingSse([': ping\n\n'], opts)); // stream stays connected
  };
  const printed = [];
  const service = { print: async (t) => { printed.push(t); return { status: 'queued' }; } };
  const sub = subscribeBills({
    baseUrl: 'http://snackk.test', deviceKey: 'k', service,
    getConfig: () => ({ stationDelivery: 'print' }),
    log: NOLOG, fetchImpl, maxBackoffMs: 5, idleTimeoutMs: 5000, reconcileMs: 1_000_000,
  });
  await new Promise((r) => setTimeout(r, 60));
  sub.stop();
  assert.equal(printed.length, 1);
  assert.equal(printed[0].id, 'bill:sb');
  assert.equal(printed[0].station, 'cashier');
  assert.equal(printed[0].number, 7);
});

test('subscribeBills recovery honors a screens-only flip (no receipt)', async () => {
  let billsFetched = false;
  const fetchImpl = (url, opts) => {
    if (url.includes('/bills/recent')) { billsFetched = true; return Promise.resolve({ ok: true, json: async () => ({ bills: [] }) }); }
    return Promise.resolve(hangingSse([': ping\n\n'], opts));
  };
  const printed = [];
  const service = { print: async (t) => { printed.push(t); return { status: 'queued' }; } };
  const sub = subscribeBills({
    baseUrl: 'http://snackk.test', deviceKey: 'k', service,
    getConfig: () => ({ stationDelivery: 'kds' }), // screens-only
    log: NOLOG, fetchImpl, maxBackoffMs: 5, idleTimeoutMs: 5000, reconcileMs: 1_000_000,
  });
  await new Promise((r) => setTimeout(r, 60));
  sub.stop();
  assert.equal(billsFetched, false, 'no recovery fetch at all when screens-only');
  assert.equal(printed.length, 0);
});

const lineVoidDto = (over = {}) => JSON.stringify({
  orderId: 'o1', ticketNumber: 1, station: 'kitchen', tableLabel: 'T1',
  placedAt: '2026-08-08T10:00:00Z', reason: 'Wrong item',
  lines: [{ id: 'L1', itemName: 'Momo', variantName: null, quantity: 1, modifiers: [], note: null }],
  ...over,
});

test('a live line.void event prints a pull chit after its KOT fired', async () => {
  // The KOT fires first (recording o1 in `printed`), then a line is pulled — the
  // chit must print because the guard sees the KOT already came out.
  const frames = [
    'retry: 3000\n\n',
    `id: 5\nevent: ticket.new\ndata: ${kotDto()}\n\n`,
    `id: 6\nevent: line.void\ndata: ${lineVoidDto()}\n\n`,
  ];
  let calls = 0;
  const fetchImpl = async (url, opts) => {
    if (url.endsWith('/active')) return { ok: true, json: async () => ({ tickets: [] }) };
    if (url.includes('/line-voids/recent')) return { ok: true, json: async () => ({ chits: [] }) };
    if (url.includes('/voids/recent')) return { ok: true, json: async () => ({ tickets: [] }) };
    calls += 1;
    return calls === 1 ? hangingSse(frames, opts) : { ok: false, status: 499, body: null };
  };

  const printed = [];
  let resolveGot;
  const got = new Promise((r) => { resolveGot = r; });
  const service = {
    print: async (t) => { printed.push(t); if (printed.length === 2) resolveGot(); return { status: 'queued' }; },
  };
  const sub = subscribeStation({
    baseUrl: 'http://snackk.test', deviceKey: 'k', station: 'kitchen',
    service, getConfig: () => ({ stationDelivery: 'print', orderRoutingMode: 'direct' }),
    printed: new Set(), log: NOLOG, fetchImpl, maxBackoffMs: 5,
    idleTimeoutMs: 1000, connectTimeoutMs: 1000, reconcileMs: 1_000_000,
  });
  await got;
  sub.stop();

  assert.equal(printed[0].voided ?? false, false, 'first slip is the KOT');
  assert.equal(printed[1].voided, true, 'second slip is the pull chit');
  assert.equal(printed[1].id, 'o1:L1');
  assert.equal(printed[1].items[0].name, 'Momo');
});

test('a pull chit missed while offline is recovered from the line-voids seed', async () => {
  // No live events — the chit only exists in the recovery window. With the KOT
  // already known printed (durable-backed `printed`), the seed must print it.
  let resolveGot;
  const got = new Promise((r) => { resolveGot = r; });
  const service = { print: async (t) => { resolveGot(t); return { status: 'queued' }; } };
  const fetchImpl = async (url, opts) => {
    if (url.endsWith('/active')) return { ok: true, json: async () => ({ tickets: [] }) };
    if (url.includes('/line-voids/recent')) return { ok: true, json: async () => ({ chits: [JSON.parse(lineVoidDto())] }) };
    if (url.includes('/voids/recent')) return { ok: true, json: async () => ({ tickets: [] }) };
    return hangingSse(['retry: 3000\n\n', ': ping\n\n'], opts); // connected, quiet
  };
  const sub = subscribeStation({
    baseUrl: 'http://snackk.test', deviceKey: 'k', station: 'kitchen',
    service, getConfig: () => ({ stationDelivery: 'print', orderRoutingMode: 'direct' }),
    printed: new Set(['o1']), log: NOLOG, fetchImpl, maxBackoffMs: 5,
    idleTimeoutMs: 1000, connectTimeoutMs: 1000, reconcileMs: 1_000_000,
  });
  const t = await got;
  sub.stop();
  assert.equal(t.voided, true);
  assert.equal(t.id, 'o1:L1');
});
