/**
 * The snackk inbound adapter: subscribe OUTBOUND to snackk's station SSE feeds
 * and print fired tickets. Outbound because snackk runs in the cloud while this
 * agent + the printer are on-prem behind NAT — the agent reaches out, so there
 * are no inbound ports to open. It calls the SAME `service.print()` the HTTP
 * inbound does; the core never learns there's an SSE upstream.
 *
 * Per station: one long-lived SSE connection, reconnecting with exponential
 * backoff. `Last-Event-ID` resumes after a blip and the hub replays the missed
 * sliver, so a short outage is lossless; a longer one is covered because the
 * print decision is idempotent (id@revision) — a replayed event never reprints.
 *
 * Survival over NAT is the whole game here. A long-lived TCP link out to the
 * cloud can die SILENTLY — a NAT/firewall idle-timeout, an ISP reset, a wifi
 * handoff, or the laptop sleeping — with no FIN ever reaching the agent. A naive
 * `while (await reader.read())` then blocks FOREVER: reconnect never runs, the
 * seed safety net never re-arms, and printing stops until someone restarts the
 * box. So every read races an IDLE WATCHDOG: snackk heartbeats `: ping` every
 * 25s (server/routes/stream.ts HEARTBEAT_MS), and if no bytes at all arrive for
 * ~2× that we abort the socket and reconnect. The initial fetch has its own
 * CONNECT timeout so a half-open proxy can't wedge us before the stream even
 * opens. A periodic RECONCILE re-seed closes the last gap — a KOT missed while
 * the stream stayed happily connected (a swallowed publish, the config-null
 * window, a single dropped frame) heals within a minute instead of only on the
 * next reconnect that may never come.
 */

import { createSseParser } from './sse-parse.js';
import { createConfigClient } from './config.js';
import { printAction, printActionSeed, billToTicket } from './map.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// snackk pings every 25s; 60s (2.4×) tolerates one dropped heartbeat before we
// judge the link dead. CONNECT is the ceiling for the initial fetch to return
// headers. RECONCILE re-seeds each station's board on a slow cadence so a missed
// KOT self-heals without waiting for a reconnect.
const IDLE_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;
const RECONCILE_MS = 90_000;

/**
 * A Set of orderIds bounded to the most recent `limit`, oldest evicted (FIFO).
 * It only records "this KOT printed, so a later void should print a VOID slip" —
 * a void arrives seconds to minutes after the fire, never days, so a bounded
 * window loses nothing real while a plain Set would grow for the life of the box.
 * (It is in-memory: a restart forgets, so a void landing AFTER a restart of an
 * order that fired BEFORE it won't emit a VOID slip — an accepted, rare gap; a
 * missing VOID is far less bad than a missing KOT, which the seed path covers.)
 * @param {number} [limit]
 * @returns {{has:(k:string)=>boolean, add:(k:string)=>void, size:()=>number}}
 */
export function boundedSet(limit = 2000) {
  const seen = new Set();
  const order = [];
  return {
    has: (k) => seen.has(k),
    add(k) {
      if (seen.has(k)) return;
      seen.add(k);
      order.push(k);
      while (order.length > limit) seen.delete(order.shift());
    },
    size: () => seen.size,
  };
}

/**
 * Open an SSE stream with a CONNECT timeout. Returns the Response plus the
 * AbortController wired to the fetch — the caller arms an idle watchdog on the
 * same controller, so aborting it (connect timeout OR idle) rejects the pending
 * read and unblocks the reconnect loop.
 * @param {{url:string, headers:Record<string,string>, fetchImpl:typeof fetch, connectTimeoutMs:number}} o
 * @returns {Promise<{res:Response, ac:AbortController}>}
 */
async function openStream({ url, headers, fetchImpl, connectTimeoutMs }) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error('connect timeout')), connectTimeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { headers, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  return { res, ac };
}

/**
 * Pump an already-open SSE body, calling `onEvent` for each parsed event until
 * the stream ends or `isStopped()` is true. Each successful read re-arms the
 * idle watchdog: any byte — a real event OR a heartbeat comment — proves the
 * link is alive; silence past `idleTimeoutMs` aborts the fetch so read() rejects
 * and the outer loop reconnects. `onByte` records liveness for /health.
 * @param {{res:Response, ac:AbortController, idleTimeoutMs:number,
 *   isStopped:()=>boolean, onEvent:(e:any)=>Promise<void>|void,
 *   onId?:(id:string)=>void, onByte?:()=>void}} o
 */
async function pump({ res, ac, idleTimeoutMs, isStopped, onEvent, onId, onByte }) {
  const parser = createSseParser();
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let idle;
  const arm = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ac.abort(new Error('idle timeout')), idleTimeoutMs);
  };
  try {
    arm();
    while (!isStopped()) {
      const { value, done } = await reader.read();
      if (done) break;
      arm();
      onByte?.();
      for (const e of parser.push(dec.decode(value, { stream: true }))) {
        if (e.id) onId?.(e.id);
        await onEvent(e);
      }
    }
  } finally {
    clearTimeout(idle);
  }
}

/**
 * Drive one station's feed. Returns a handle with stop() and status().
 * @param {{baseUrl:string, deviceKey:string, station:string,
 *   service:import('../../core/service.js').PrintService,
 *   getConfig:()=>any, printed:Set<string>, log?:any,
 *   fetchImpl?:typeof fetch, maxBackoffMs?:number,
 *   idleTimeoutMs?:number, connectTimeoutMs?:number, reconcileMs?:number}} o
 */
export function subscribeStation({
  baseUrl, deviceKey, station, service, getConfig, printed,
  log = console, fetchImpl = fetch, maxBackoffMs = 30_000,
  idleTimeoutMs = IDLE_TIMEOUT_MS, connectTimeoutMs = CONNECT_TIMEOUT_MS, reconcileMs = RECONCILE_MS,
}) {
  let stopped = false;
  let lastEventId;
  let attempt = 0;
  let reconcileTimer = null;
  let activeAc = null; // the current connection's controller, so stop() tears down at once
  // Live view of the link, exposed on /health so E2E can tell at a glance whether
  // the agent is actually subscribed (vs. quietly wedged) without reading logs.
  const status = {
    station, connected: false, lastEventId: undefined,
    lastByteAt: 0, lastEventAt: 0, seeds: 0, connects: 0, lastError: null,
  };

  // Execute a print decision and remember a first KOT/BOT so a later void of it
  // prints a slip (a void of a never-fired ticket stays silent). Only on a real
  // accept, so a transient failure we retry later still counts as "not yet
  // printed". Shared by the live stream and the seed path.
  async function applyDecision(dto, decision) {
    if (decision.action !== 'print') return;
    const result = await service.print(decision.ticket);
    if (decision.firstPrint && (result.status === 'queued' || result.status === 'duplicate')) {
      printed.add(dto.orderId);
    }
    log.info?.(`[snackk] ${station} ${dto.orderId} → ${result.status} (${decision.reason})`);
  }

  async function handle(dto) {
    const cfg = getConfig();
    if (!cfg) return; // config not loaded yet — drop; a live ticket or reconcile will follow
    await applyDecision(dto, printAction(dto, cfg, printed));
  }

  // Seed the current board: the live stream only fires on the fire-state EVENT,
  // and the hub's replay buffer is bounded and dropped when the channel's last
  // subscriber leaves — so a KOT that fired while this agent was disconnected (or
  // while it was the only subscriber, in print-only mode) would never print. It
  // also heals a KOT missed with the stream STILL connected (a config-null drop
  // in handle(), a publish snackk swallowed, a single dropped frame), which is
  // why it runs both on (re)connect AND on the reconcile interval. The durable
  // id@0 store dedupes, so a re-seed of an already-printed ticket is a no-op.
  async function seedActive() {
    const cfg = getConfig();
    if (!cfg) return; // no config yet — the config poll + a live event will cover it
    let tickets;
    try {
      const res = await fetchImpl(`${baseUrl}/api/print/station/${station}/active`, {
        headers: { Authorization: `Bearer ${deviceKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`active → HTTP ${res.status}`);
      ({ tickets } = await res.json());
    } catch (err) {
      // Non-fatal: a live event, the next reconcile, or the next reconnect covers it.
      log.warn?.(`[snackk] ${station} seed failed: ${err.message}`);
      return;
    }
    for (const dto of Array.isArray(tickets) ? tickets : []) {
      try {
        await applyDecision(dto, printActionSeed(dto, cfg, printed));
      } catch (err) {
        log.warn?.(`[snackk] ${station} bad seed ticket: ${err.message}`);
      }
    }
    status.seeds += 1;
  }

  async function connectOnce() {
    const headers = { Authorization: `Bearer ${deviceKey}`, Accept: 'text/event-stream' };
    if (lastEventId) headers['Last-Event-ID'] = lastEventId;
    const { res, ac } = await openStream({
      url: `${baseUrl}/api/stream/print/station/${station}`, headers, fetchImpl, connectTimeoutMs,
    });
    activeAc = ac;
    attempt = 0; // connected — reset the backoff ladder
    status.connected = true;
    status.connects += 1;
    status.lastByteAt = Date.now();
    log.info?.(`[snackk] subscribed ${station}`);
    // Seed before draining the live stream: any event that lands meanwhile is
    // read right after and deduped by the durable store, so the overlap is safe.
    await seedActive();
    try {
      await pump({
        res, ac, idleTimeoutMs, isStopped: () => stopped,
        onByte: () => { status.lastByteAt = Date.now(); },
        onId: (id) => { lastEventId = id; status.lastEventId = id; },
        onEvent: async (e) => {
          if (e.event === 'ticket.new' || e.event === 'ticket.updated') {
            status.lastEventAt = Date.now();
            try {
              await handle(JSON.parse(e.data));
            } catch (err) {
              log.warn?.(`[snackk] bad frame on ${station}: ${err.message}`);
            }
          }
        },
      });
    } finally {
      activeAc = null;
      status.connected = false;
    }
  }

  (async () => {
    while (!stopped) {
      try {
        await connectOnce();
      } catch (err) {
        if (!stopped) {
          status.lastError = err.message;
          log.warn?.(`[snackk] ${station} disconnected: ${err.message}`);
        }
      }
      if (stopped) break;
      await sleep(Math.min(maxBackoffMs, 500 * 2 ** attempt++));
    }
  })();

  // Belt-and-suspenders reconcile: re-seed the board on a slow cadence regardless
  // of stream health, so a missed KOT heals within ~a minute instead of only when
  // a reconnect happens to fire. Idempotent (durable store dedupes) and cheap.
  reconcileTimer = setInterval(() => {
    seedActive().catch((err) => log.warn?.(`[snackk] ${station} reconcile: ${err?.message}`));
  }, reconcileMs);
  reconcileTimer.unref?.(); // never keep the process alive just to reconcile

  return {
    stop() {
      stopped = true;
      if (reconcileTimer) clearInterval(reconcileTimer);
      activeAc?.abort(new Error('stopped')); // tear the live connection down now, don't wait for idle
    },
    status: () => ({ ...status, idleForMs: status.lastByteAt ? Date.now() - status.lastByteAt : null }),
  };
}

/**
 * Drive the restaurant's BILL feed (one channel, not per-station). Settled bills
 * arrive as `bill.print`; each maps to a cashier receipt and prints via the same
 * service.print() — money passed through verbatim (billToTicket). Mirrors
 * subscribeStation's reconnect/backoff + Last-Event-ID resume AND its idle
 * watchdog / connect timeout; no seed and no void/printed-set logic — a settle
 * fires once and a bill is never voided.
 * @param {{baseUrl:string, deviceKey:string,
 *   service:import('../../core/service.js').PrintService,
 *   getConfig:()=>any, log?:any, fetchImpl?:typeof fetch, maxBackoffMs?:number,
 *   idleTimeoutMs?:number, connectTimeoutMs?:number}} o
 */
export function subscribeBills({
  baseUrl, deviceKey, service, getConfig, log = console, fetchImpl = fetch, maxBackoffMs = 30_000,
  idleTimeoutMs = IDLE_TIMEOUT_MS, connectTimeoutMs = CONNECT_TIMEOUT_MS,
}) {
  let stopped = false;
  let lastEventId;
  let attempt = 0;
  let activeAc = null;
  const status = {
    station: 'bills', connected: false, lastEventId: undefined,
    lastByteAt: 0, lastEventAt: 0, connects: 0, lastError: null,
  };

  async function handleBill(bill) {
    // The server only emits when delivery includes paper, but re-check the live
    // config so a bill queued just before the owner flipped back to screens-only
    // never prints late.
    if (getConfig()?.stationDelivery === 'kds') return;
    const result = await service.print(billToTicket(bill));
    log.info?.(`[snackk] bill ${bill.sessionId} → ${result.status}`);
  }

  async function connectOnce() {
    const headers = { Authorization: `Bearer ${deviceKey}`, Accept: 'text/event-stream' };
    if (lastEventId) headers['Last-Event-ID'] = lastEventId;
    const { res, ac } = await openStream({
      url: `${baseUrl}/api/stream/print/bills`, headers, fetchImpl, connectTimeoutMs,
    });
    activeAc = ac;
    attempt = 0;
    status.connected = true;
    status.connects += 1;
    status.lastByteAt = Date.now();
    log.info?.('[snackk] subscribed bills');
    try {
      await pump({
        res, ac, idleTimeoutMs, isStopped: () => stopped,
        onByte: () => { status.lastByteAt = Date.now(); },
        onId: (id) => { lastEventId = id; status.lastEventId = id; },
        onEvent: async (e) => {
          if (e.event === 'bill.print') {
            status.lastEventAt = Date.now();
            try {
              await handleBill(JSON.parse(e.data));
            } catch (err) {
              log.warn?.(`[snackk] bad bill frame: ${err.message}`);
            }
          }
        },
      });
    } finally {
      activeAc = null;
      status.connected = false;
    }
  }

  (async () => {
    while (!stopped) {
      try {
        await connectOnce();
      } catch (err) {
        if (!stopped) {
          status.lastError = err.message;
          log.warn?.(`[snackk] bills disconnected: ${err.message}`);
        }
      }
      if (stopped) break;
      await sleep(Math.min(maxBackoffMs, 500 * 2 ** attempt++));
    }
  })();

  return {
    stop() {
      stopped = true;
      activeAc?.abort(new Error('stopped'));
    },
    status: () => ({ ...status, idleForMs: status.lastByteAt ? Date.now() - status.lastByteAt : null }),
  };
}

/**
 * Start the whole snackk inbound: load config, then subscribe every station AND
 * the bill feed. Opt-in from boot — only called when a snackk URL + device key
 * are configured, so the HTTP inbound path is untouched when it isn't.
 * @param {{baseUrl:string, deviceKey:string,
 *   service:import('../../core/service.js').PrintService,
 *   stations?:string[], log?:any, fetchImpl?:typeof fetch}} o
 */
export async function startSnackkAgent({
  baseUrl, deviceKey, service, stations = ['kitchen', 'bar'], log = console, fetchImpl = fetch,
}) {
  const config = createConfigClient({ baseUrl, deviceKey, fetchImpl, log });
  // Never throws: an unreachable snackk or a not-yet-enabled tenant must not take
  // down the local HTTP inbound. It logs and keeps polling; the agent starts
  // delivering the moment the config comes good.
  await config.start();
  const printed = boundedSet();
  const subs = stations.map((station) =>
    subscribeStation({ baseUrl, deviceKey, station, service, getConfig: () => config.get(), printed, log, fetchImpl }),
  );
  // The cashier's settled-bill feed rides alongside the station feeds.
  subs.push(subscribeBills({ baseUrl, deviceKey, service, getConfig: () => config.get(), log, fetchImpl }));
  log.info?.(`[snackk] agent started → ${baseUrl} (stations: ${stations.join(', ')} + bills)`);
  return {
    stop() {
      config.stop();
      for (const s of subs) s.stop();
    },
    /** Snapshot for /health: is the agent actually subscribed, and how fresh? */
    status() {
      const cfg = config.get();
      const feeds = subs.map((s) => s.status());
      return {
        enabled: true,
        // config-less means the first config fetch hasn't succeeded yet (snackk
        // unreachable or the tenant hasn't enabled printing); feeds still connect.
        state: cfg ? 'running' : 'awaiting-config',
        url: baseUrl,
        config: cfg ? { stationDelivery: cfg.stationDelivery, orderRoutingMode: cfg.orderRoutingMode } : null,
        connected: feeds.filter((f) => f.connected).length,
        feeds,
      };
    },
  };
}
