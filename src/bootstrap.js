/**
 * Bootstrap — turn config into a live PrintService. Responsibilities:
 *   • pick a durable file store (or in-memory),
 *   • resolve each printer's address (discover by MAC, fall back to fixed host),
 *   • build a transport + durable queue per printer and recover pending jobs,
 *   • wire the PrintService. No HTTP/SSE here — that's the caller's choice.
 */
import { PrinterQueue } from './core/queue.js';
import { PrintService } from './core/service.js';
import { tcpTransport } from './adapters/transport/tcp.js';
import { fakeTransport } from './adapters/transport/fake.js';
import { previewSink } from './adapters/preview-sink.js';
import { fileStore } from './adapters/store/file.js';
import { memoryStore } from './adapters/store/memory.js';
import { fileIdempotency } from './adapters/store/idempotency-file.js';
import { memoryIdempotency } from './core/idempotency.js';
import { discoverPrinters, normalizeMac, resolveHostMac } from './adapters/discovery/scan.js';
import { printerStations } from './config.js';
import { logEvent, log } from './logger.js';

/**
 * @param {any} cfg  from loadConfig()
 * @param {{onEvent?:(e:any)=>void}} [opts]
 */
export async function buildService(cfg, { onEvent = logEvent } = {}) {
  const store = cfg.store?.dir ? await fileStore(cfg.store.dir) : memoryStore();
  // Idempotency matches the store's durability: durable on disk, or in-memory.
  const idempotency = cfg.store?.dir ? await fileIdempotency(cfg.store.dir) : memoryIdempotency();

  // Resolve MAC-configured printers to an IP. Do it in the cheapest way that still
  // survives a DHCP move: first confirm each printer is still at its CONFIGURED
  // host (a single probe, no scan); only if some MAC is still unplaced do we sweep
  // the subnet. In the common case the printer hasn't moved, so no port scan ever
  // touches the LAN.
  let macToIp = new Map();
  const macPrinters = Object.entries(cfg.printers).filter(([, p]) => p.mac);
  if (cfg.discovery.enabled && macPrinters.length) {
    const want = new Set(macPrinters.map(([, p]) => normalizeMac(p.mac)).filter(Boolean));
    try {
      // 1) Targeted: is each printer still answering at its configured host?
      for (const [, p] of macPrinters) {
        const mac = await resolveHostMac(p.host, p.port ?? 9100);
        if (mac && want.has(mac) && !macToIp.has(mac)) macToIp.set(mac, p.host);
      }
      // 2) Fallback: sweep the LAN only for MACs we still couldn't place.
      const missing = [...want].filter((m) => !macToIp.has(m));
      if (missing.length) {
        log.info('scanning LAN for printers…', { subnet: cfg.discovery.subnet ?? 'auto', missing: missing.length });
        const hosts = macPrinters.map(([, p]) => p.host).filter(Boolean);
        const found = await discoverPrinters({ subnet: cfg.discovery.subnet, hosts });
        for (const { ip, mac } of found) if (mac && want.has(mac) && !macToIp.has(mac)) macToIp.set(mac, ip);
        log.info(`discovery found ${found.length} printer port(s)`, { placed: macToIp.size });
      }
    } catch (e) { log.warn('discovery failed, using configured hosts', { error: String(e.message || e) }); }
  }

  const printers = new Map();
  for (const [id, p] of Object.entries(cfg.printers)) {
    const stations = printerStations(p);
    // Preview: a printer with no stations can never be routed to — skip the noise.
    if (cfg.preview && stations.length === 0) continue;
    const host = (p.mac && macToIp.get(normalizeMac(p.mac))) || p.host || null;
    // Preview mode needs no address — the fake transport swallows the bytes and the
    // preview sink shows the slip instead. Only the real path requires a host.
    if (!host && !cfg.preview) { log.error(`printer "${id}" has no address (mac not found, no host) — station(s) "${stations.join(', ')}" will not print`, {}); continue; }
    const transport = cfg.preview ? fakeTransport() : tcpTransport({ host, port: p.port ?? 9100 });
    const queue = new PrinterQueue({ printerId: id, transport, store, onEvent, policy: cfg.policy });
    await queue.recover();
    printers.set(id, { queue, width: p.width ?? 48, encoding: p.encoding ?? 'latin1', cut: p.cut !== false, cutFeed: p.cutFeed, docKind: p.docKind });
    log.info(`printer "${id}" -> ${transport.describe}${cfg.preview ? ' (PREVIEW — no hardware)' : ''}`, { stations, source: p.mac && macToIp.get(normalizeMac(p.mac)) ? 'discovered' : 'configured' });
  }

  // Hydrate idempotency from jobs that outlived the last run: a still-pending or
  // dead-lettered job was already accepted, so a re-send of the same key after a
  // restart must be recognized as a duplicate. This closes the narrow window
  // between enqueue() and commit() where a crash could otherwise let it reprint.
  const known = [...(await store.list()), ...(await store.listDead())].map((j) => j.key ?? j.id);
  if (known.length) await idempotency.seed(known);

  const service = new PrintService({
    printers,
    stationToPrinter: cfg.stationToPrinter,
    branding: { shopName: cfg.shop.name, shopLines: cfg.shop.lines },
    idempotency,
    onEvent,
    preview: cfg.preview ? previewSink({ dir: cfg.store?.dir ?? null }) : null,
  });
  if (cfg.preview) log.info('PREVIEW mode: slips render to the terminal' + (cfg.store?.dir ? ` + ${cfg.store.dir}/preview-slips.txt` : '') + ' — no printer used');
  return { service, printers, store, idempotency };
}
