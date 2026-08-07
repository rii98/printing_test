/**
 * Printer discovery. Cheap ESC/POS clones don't do mDNS, so we scan the local
 * /24 for anything answering on port 9100, then resolve each hit's MAC from the
 * ARP table. Mapping printers by MAC (stable) instead of IP (may change via DHCP)
 * is what makes "run it and go" survive a printer getting a new address.
 */
import net from 'node:net';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

/** Every IPv4 /24 this host sits on (usually one). */
export function localSubnets() {
  const nets = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) nets.push(a.address.split('.').slice(0, 3).join('.'));
    }
  }
  return [...new Set(nets)];
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

/** Resolve a MAC for an IP from the OS ARP cache (best-effort). */
export async function macFor(ip) {
  try {
    const { stdout } = await pexec('arp', ['-n', ip]);
    const m = stdout.match(/([0-9a-f]{1,2}:){5}[0-9a-f]{1,2}/i);
    return m ? normalizeMac(m[0]) : null;
  } catch { return null; }
}

export const normalizeMac = (mac) =>
  mac.toLowerCase().split(':').map((o) => o.padStart(2, '0')).join(':');

/**
 * Scan one or all local subnets for port-9100 devices.
 * @param {{subnet?:string, port?:number, timeoutMs?:number, concurrency?:number}} [opts]
 * @returns {Promise<Array<{ip:string, mac:string|null}>>}
 */
export async function discoverPrinters({ subnet, port = 9100, timeoutMs = 400, concurrency = 64 } = {}) {
  const subnets = subnet ? [subnet] : localSubnets();
  const targets = [];
  for (const s of subnets) for (let i = 1; i <= 254; i++) targets.push(`${s}.${i}`);

  const found = [];
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const ip = targets[cursor++];
      if (await checkPort(ip, port, timeoutMs)) found.push(ip);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  // Resolve MACs (ARP is populated by the successful TCP handshake above).
  return Promise.all(found.sort().map(async (ip) => ({ ip, mac: await macFor(ip) })));
}
