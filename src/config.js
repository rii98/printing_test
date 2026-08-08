/**
 * Configuration. Sensible defaults out of the box (your current printer), with
 * three override layers, most-specific wins:
 *   1. defaults below
 *   2. a printers.json file in the project root (git-ignorable, per-site)
 *   3. environment variables (PRINT_*)
 *
 * A printer entry may specify `host` (fixed IP) OR `mac` (discovered on the LAN),
 * or both (mac preferred; host is the fallback if discovery finds nothing).
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { log } from './logger.js';

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

/**
 * Read a numeric env override safely. A typo like PRINT_HTTP_PORT=":4000" used to
 * become NaN and silently bind a random port / a 0ms shutdown grace. Instead we
 * accept only a valid integer in range, and otherwise KEEP the current value and
 * warn loudly — a misconfiguration must never quietly change behaviour.
 * @param {string} name  env var name
 * @param {number} current  value to keep if the override is absent or invalid
 * @param {(n:number)=>boolean} [ok]  range predicate
 * @returns {number}
 */
function envInt(name, current, ok = (n) => n >= 0) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return current;
  const n = Number(raw);
  if (Number.isInteger(n) && ok(n)) return n;
  log.warn(`ignoring ${name}=${JSON.stringify(raw)} — not a valid value; keeping ${current}`);
  return current;
}

/** @returns {any} */
function defaults() {
  return {
    shop: { name: 'NAMASTE MINI MARKET', lines: [] },
    http: { port: 4000 },
    auth: { token: null },   // shared secret for /print; null = open (dev only)
    store: { dir: path.join(ROOT, '.queue') },   // durable; set to null for in-memory
    policy: { maxAttempts: 8, baseDelayMs: 500, maxDelayMs: 30_000 },
    discovery: { enabled: true, subnet: null },
    shutdown: { graceMs: 10_000 },   // max time to drain in-flight prints before exiting

    // snackk integration (outbound SSE). Off unless a URL + device key are set,
    // so the HTTP inbound is the only path by default. The device key is minted
    // in snackk's Settings (POST /api/settings/printer-device).
    snackk: { url: null, deviceKey: null, stations: ['kitchen', 'bar'] },

    // printerId -> printer. A printer serves one or more STATIONS (a ticket's
    // station routes it to a printer); use `station` for one or `stations` for
    // several. This shop has ONE POS-8360, so the single device serves cashier,
    // kitchen AND bar — one entry, one queue, so the three stations share the
    // printer's single 9100 connection instead of three queues fighting over it.
    printers: {
      pos: { stations: ['cashier', 'kitchen', 'bar'], host: '192.168.18.240', mac: '02:1f:e0:13:19:28', port: 9100, width: 48, encoding: 'latin1', cut: true, cutFeed: 7 },
      // A second physical printer? Give it its own entry and its own stations —
      // host OR mac is enough — and drop those stations from `pos` above:
      // kitchen: { station: 'kitchen', mac: 'aa:bb:cc:dd:ee:ff', width: 48 },
    },
  };
}

function loadFile() {
  const f = path.join(ROOT, 'printers.json');
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { throw new Error(`printers.json is not valid JSON: ${e.message}`); }
}

function applyEnv(cfg) {
  cfg.http.port = envInt('PRINT_HTTP_PORT', cfg.http.port, (n) => n >= 0 && n <= 65535);
  if (process.env.PRINT_SHOP_NAME) cfg.shop.name = process.env.PRINT_SHOP_NAME;
  if (process.env.PRINT_STORE_DIR) cfg.store.dir = process.env.PRINT_STORE_DIR;
  if (process.env.PRINT_STORE_DIR === 'memory') cfg.store.dir = null;
  if (process.env.PRINT_DISCOVERY === 'off') cfg.discovery.enabled = false;
  if (process.env.PRINT_SUBNET) cfg.discovery.subnet = process.env.PRINT_SUBNET;
  cfg.shutdown.graceMs = envInt('PRINT_SHUTDOWN_GRACE_MS', cfg.shutdown.graceMs, (n) => n >= 0);
  if (process.env.PRINT_API_KEY) cfg.auth.token = process.env.PRINT_API_KEY;
  if (process.env.SNACKK_URL) cfg.snackk.url = process.env.SNACKK_URL.replace(/\/+$/, '');
  if (process.env.SNACKK_DEVICE_KEY) cfg.snackk.deviceKey = process.env.SNACKK_DEVICE_KEY;
  if (process.env.SNACKK_STATIONS) cfg.snackk.stations = process.env.SNACKK_STATIONS.split(',').map((s) => s.trim()).filter(Boolean);
  return cfg;
}

/** Merge printers per-key so a file override can tweak one printer. */
function merge(base, over) {
  const out = { ...base, ...over };
  out.shop = { ...base.shop, ...over.shop };
  out.http = { ...base.http, ...over.http };
  out.auth = { ...base.auth, ...over.auth };
  out.store = { ...base.store, ...over.store };
  out.policy = { ...base.policy, ...over.policy };
  out.discovery = { ...base.discovery, ...over.discovery };
  out.shutdown = { ...base.shutdown, ...over.shutdown };
  out.snackk = { ...base.snackk, ...over.snackk };
  out.printers = { ...base.printers };
  for (const [id, p] of Object.entries(over.printers ?? {})) out.printers[id] = { ...base.printers[id], ...p };
  return out;
}

/** A printer's stations, normalized: accepts `stations: [...]` or a single `station`. */
export function printerStations(p) {
  if (Array.isArray(p.stations)) return p.stations;
  if (p.station) return [p.station];
  return [];
}

export function loadConfig() {
  const cfg = applyEnv(merge(defaults(), loadFile()));
  // Derived: station -> printerId. One printer may serve several stations, but a
  // station maps to exactly one printer — reject two printers claiming the same.
  cfg.stationToPrinter = {};
  for (const [id, p] of Object.entries(cfg.printers)) {
    for (const station of printerStations(p)) {
      if (cfg.stationToPrinter[station]) throw new Error(`two printers claim station "${station}": ${cfg.stationToPrinter[station]} and ${id}`);
      cfg.stationToPrinter[station] = id;
    }
  }
  return cfg;
}
