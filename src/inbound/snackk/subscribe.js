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
import { printAction } from './map.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  async function handle(dto) {
    const cfg = getConfig();
    if (!cfg) return; // config not loaded yet — drop; a live ticket will follow
    const decision = printAction(dto, cfg, printed);
    if (decision.action !== 'print') return;
    const result = await service.print(decision.ticket);
    // Remember a first KOT/BOT so a later void of it prints a slip (and a void of
    // a never-fired ticket stays silent). Only on a real accept, so a transient
    // failure that we retry later still counts as "not yet printed".
    if (decision.firstPrint && (result.status === 'queued' || result.status === 'duplicate')) {
      printed.add(dto.orderId);
    }
    log.info?.(`[snackk] ${station} ${dto.orderId} → ${result.status} (${decision.reason})`);
  }

  async function connectOnce() {
    const headers = { Authorization: `Bearer ${deviceKey}`, Accept: 'text/event-stream' };
    if (lastEventId) headers['Last-Event-ID'] = lastEventId;
    const res = await fetchImpl(`${baseUrl}/api/stream/print/station/${station}`, { headers });
    if (!res.ok || !res.body) throw new Error(`stream → HTTP ${res.status}`);
    attempt = 0; // connected — reset the backoff ladder
    log.info?.(`[snackk] subscribed ${station}`);
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
  await config.start(); // throws if URL/key are wrong — fail fast at boot
  const printed = new Set();
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
