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
import { fileStore } from './adapters/store/file.js';
import { memoryStore } from './adapters/store/memory.js';
import { fileIdempotency } from './adapters/store/idempotency-file.js';
import { memoryIdempotency } from './core/idempotency.js';
import { discoverPrinters, normalizeMac } from './adapters/discovery/scan.js';
import { logEvent, log } from './logger.js';

/**
 * @param {any} cfg  from loadConfig()
 * @param {{onEvent?:(e:any)=>void}} [opts]
 */
export async function buildService(cfg, { onEvent = logEvent } = {}) {
  const store = cfg.store?.dir ? await fileStore(cfg.store.dir) : memoryStore();
  // Idempotency matches the store's durability: durable on disk, or in-memory.
  const idempotency = cfg.store?.dir ? await fileIdempotency(cfg.store.dir) : memoryIdempotency();

  // Resolve addresses: if any printer is MAC-configured and discovery is on, scan.
  let macToIp = new Map();
  const needsDiscovery = cfg.discovery.enabled && Object.values(cfg.printers).some((p) => p.mac);
  if (needsDiscovery) {
    log.info('scanning LAN for printers…', { subnet: cfg.discovery.subnet ?? 'auto' });
    try {
      const found = await discoverPrinters({ subnet: cfg.discovery.subnet });
      for (const { ip, mac } of found) if (mac) macToIp.set(mac, ip);
      log.info(`discovery found ${found.length} printer port(s)`, { withMac: macToIp.size });
    } catch (e) { log.warn('discovery failed, using configured hosts', { error: String(e.message || e) }); }
  }

  const printers = new Map();
  for (const [id, p] of Object.entries(cfg.printers)) {
    const host = (p.mac && macToIp.get(normalizeMac(p.mac))) || p.host || null;
    if (!host) { log.error(`printer "${id}" has no address (mac not found, no host) — station "${p.station}" will not print`, {}); continue; }
    const transport = tcpTransport({ host, port: p.port ?? 9100 });
    const queue = new PrinterQueue({ printerId: id, transport, store, onEvent, policy: cfg.policy });
    await queue.recover();
    printers.set(id, { queue, width: p.width ?? 48, encoding: p.encoding ?? 'latin1', cut: p.cut !== false, cutFeed: p.cutFeed, docKind: p.docKind });
    log.info(`printer "${id}" -> ${transport.describe}`, { station: p.station, source: p.mac && macToIp.get(normalizeMac(p.mac)) ? 'discovered' : 'configured' });
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
  });
  return { service, printers, store, idempotency };
}
