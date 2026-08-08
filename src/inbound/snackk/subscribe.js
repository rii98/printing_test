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
 */

import { createSseParser } from './sse-parse.js';
import { createConfigClient } from './config.js';
import { printAction, printActionSeed } from './map.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
 * Drive one station's feed. Returns a handle with stop().
 * @param {{baseUrl:string, deviceKey:string, station:string,
 *   service:import('../../core/service.js').PrintService,
 *   getConfig:()=>any, printed:Set<string>, log?:any,
 *   fetchImpl?:typeof fetch, maxBackoffMs?:number}} o
 */
export function subscribeStation({
  baseUrl, deviceKey, station, service, getConfig, printed,
  log = console, fetchImpl = fetch, maxBackoffMs = 30_000,
}) {
  let stopped = false;
  let lastEventId;
  let attempt = 0;

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
    if (!cfg) return; // config not loaded yet — drop; a live ticket will follow
    await applyDecision(dto, printAction(dto, cfg, printed));
  }

  // Seed on (re)connect: the live stream only fires on the fire-state EVENT, and
  // the hub's replay buffer is bounded and dropped when the channel's last
  // subscriber leaves — so a KOT that fired while this agent was disconnected (or
  // while it was the only subscriber, in print-only mode) would never print. Pull
  // the current board and print anything not already in the durable store, which
  // dedupes so a re-seed never reprints.
  async function seedActive() {
    const cfg = getConfig();
    if (!cfg) return; // no config yet — the config poll + a live event will cover it
    let tickets;
    try {
      const res = await fetchImpl(`${baseUrl}/api/print/station/${station}/active`, {
        headers: { Authorization: `Bearer ${deviceKey}`, Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`active → HTTP ${res.status}`);
      ({ tickets } = await res.json());
    } catch (err) {
      // Non-fatal: a live event or the next reconnect's seed still covers it.
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
  }

  async function connectOnce() {
    const headers = { Authorization: `Bearer ${deviceKey}`, Accept: 'text/event-stream' };
    if (lastEventId) headers['Last-Event-ID'] = lastEventId;
    const res = await fetchImpl(`${baseUrl}/api/stream/print/station/${station}`, { headers });
    if (!res.ok || !res.body) throw new Error(`stream → HTTP ${res.status}`);
    attempt = 0; // connected — reset the backoff ladder
    log.info?.(`[snackk] subscribed ${station}`);
    // Seed before draining the live stream: any event that lands meanwhile is
    // read right after and deduped by the durable store, so the overlap is safe.
    await seedActive();
    const parser = createSseParser();
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    while (!stopped) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const e of parser.push(dec.decode(value, { stream: true }))) {
        if (e.id) lastEventId = e.id;
        if (e.event === 'ticket.new' || e.event === 'ticket.updated') {
          try {
            await handle(JSON.parse(e.data));
          } catch (err) {
            log.warn?.(`[snackk] bad frame on ${station}: ${err.message}`);
          }
        }
      }
    }
  }

  (async () => {
    while (!stopped) {
      try {
        await connectOnce();
      } catch (err) {
        if (!stopped) log.warn?.(`[snackk] ${station} disconnected: ${err.message}`);
      }
      if (stopped) break;
      await sleep(Math.min(maxBackoffMs, 500 * 2 ** attempt++));
    }
  })();

  return { stop() { stopped = true; } };
}

/**
 * Start the whole snackk inbound: load config, then subscribe every station.
 * Opt-in from boot — only called when a snackk URL + device key are configured,
 * so the HTTP inbound path is untouched when it isn't.
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
  log.info?.(`[snackk] agent started → ${baseUrl} (stations: ${stations.join(', ')})`);
  return {
    stop() {
      config.stop();
      for (const s of subs) s.stop();
    },
  };
}
