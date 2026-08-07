/**
 * Printer discovery. Cheap ESC/POS clones don't do mDNS, so we resolve a printer
 * by its MAC (stable) rather than its IP (which DHCP may change). Two ways in:
 *   • resolveHostMac() — probe a KNOWN host and read its MAC. The common case:
 *     the printer is still at its configured IP, so no subnet scan is needed.
 *   • discoverPrinters() — sweep the local /24 for anything on port 9100 and map
 *     each hit to a MAC. The fallback for when a printer has moved.
 * Keeping the "known host first" path is what keeps the port scan off the wire in
 * the normal case (see bootstrap.js).
 */
import net from 'node:net';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

/** This host's own IPv4 addresses — never worth probing during a scan. */
export function localIPv4s() {
  const ips = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
  }
  return [...new Set(ips)];
}

/** Every IPv4 /24 this host sits on (usually one). */
export function localSubnets() {
  return [...new Set(localIPv4s().map((ip) => ip.split('.').slice(0, 3).join('.')))];
}

function checkPort(host, port, timeout) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout, () => done(false));
    s.once('error', () => done(false));
    s.connect({ host, port }, () => done(true));
  });
}

/**
 * Normalize a MAC to lowercase colon form (aa:bb:cc:dd:ee:ff), accepting the
 * shapes real tools emit: colon (Linux/macOS), dash (Windows `arp`), dotted
 * (Cisco aabb.ccdd.eeff), or bare 12 hex — with or without leading zeros.
 * Returns null for anything that isn't a 48-bit MAC, so callers can't build a
 * bogus key from garbage.
 * @param {unknown} mac
 * @returns {string|null}
 */
export function normalizeMac(mac) {
  if (typeof mac !== 'string') return null;
  const s = mac.trim().toLowerCase();
  // Dotted Cisco form: aabb.ccdd.eeff
  if (/^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/.test(s)) return s.replace(/\./g, '').match(/../g).join(':');
  // Bare 12 hex, no separators
  if (/^[0-9a-f]{12}$/.test(s)) return s.match(/../g).join(':');
  // Colon- or dash-separated, 6 groups of 1–2 hex. macOS `arp` drops leading
  // zeros (2:1f:...), so pad each octet rather than demanding a fixed length.
  const parts = s.split(/[:-]/);
  if (parts.length === 6 && parts.every((o) => /^[0-9a-f]{1,2}$/.test(o))) {
    return parts.map((o) => o.padStart(2, '0')).join(':');
  }
  return null;
}

/**
 * Extract the first MAC address from a chunk of `arp` output. Pure and total, so
 * it's unit-testable against Linux/macOS/Windows samples without shelling out.
 * Handles colon- and dash-separated octets, with or without leading zeros.
 * @param {string} text
 * @returns {string|null} normalized MAC, or null if none present
 */
export function parseMac(text) {
  const m = String(text).match(/\b([0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2}\b/i);
  return m ? normalizeMac(m[0]) : null;
}

/** Resolve a MAC for an IP from the OS ARP cache (best-effort). */
export async function macFor(ip) {
  try {
    const { stdout } = await pexec('arp', ['-n', ip]);
    return parseMac(stdout);
  } catch { return null; }
}

/**
 * Probe a KNOWN host:port and, if it answers, resolve its MAC. Lets us confirm a
 * configured printer is still home without scanning the whole subnet.
 * @returns {Promise<string|null>} normalized MAC, or null if unreachable/unknown
 */
export async function resolveHostMac(host, port = 9100, timeoutMs = 400, deps = {}) {
  const _checkPort = deps.checkPort ?? checkPort;
  const _macFor = deps.macFor ?? macFor;
  if (!host || !(await _checkPort(host, port, timeoutMs))) return null;
  return _macFor(host);
}

/**
 * Scan one or all local subnets for port-9100 devices, mapping each to a MAC.
 * Configured `hosts` are probed first (and may live off the scanned subnet); our
 * own addresses are never probed; every target is de-duplicated. IO deps are
 * injectable purely so the target-selection logic can be unit-tested.
 * @param {{subnet?:string, port?:number, timeoutMs?:number, concurrency?:number, hosts?:string[], deps?:{checkPort?:Function, macFor?:Function}}} [opts]
 * @returns {Promise<Array<{ip:string, mac:string|null}>>}
 */
export async function discoverPrinters({ subnet, port = 9100, timeoutMs = 400, concurrency = 64, hosts = [], deps = {} } = {}) {
  const _checkPort = deps.checkPort ?? checkPort;
  const _macFor = deps.macFor ?? macFor;

  const subnets = subnet ? [subnet] : localSubnets();
  const own = new Set(localIPv4s());
  const sweep = [];
  for (const s of subnets) for (let i = 1; i <= 254; i++) sweep.push(`${s}.${i}`);

  // Known hosts first, then the sweep; skip our own IPs and any duplicate.
  const seen = new Set();
  const targets = [];
  for (const ip of [...hosts, ...sweep]) {
    if (!ip || own.has(ip) || seen.has(ip)) continue;
    seen.add(ip); targets.push(ip);
  }

  const found = [];
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const ip = targets[cursor++];
      if (await _checkPort(ip, port, timeoutMs)) found.push(ip);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  // Resolve MACs (ARP is populated by the successful TCP handshake above).
  return Promise.all(found.sort().map(async (ip) => ({ ip, mac: await _macFor(ip) })));
}
