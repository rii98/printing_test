/** Shared helpers for the verification scripts (bin/verify.js). */
import readline from 'node:readline';
import { loadConfig } from '../src/config.js';
import { buildService } from '../src/bootstrap.js';

/**
 * Build a live service for hands-on testing. Discovery is disabled (we use the
 * configured host directly, which is faster and works even while the printer is
 * unplugged). Any station without its own printer falls back to the first one,
 * so a single pilot printer can stand in for kitchen/bar/cashier.
 * @param {{policy?:object}} [opts]
 */
export async function demoService({ policy } = {}) {
  const cfg = loadConfig();
  cfg.discovery.enabled = false;            // use static host; no LAN scan
  if (policy) cfg.policy = { ...cfg.policy, ...policy };
  const { service, printers } = await buildService(cfg);
  const first = [...printers.keys()][0];
  if (!first) throw new Error('no printer configured — check src/config.js / printers.json');
  for (const st of ['kitchen', 'bar', 'cashier'])
    if (!service.stationToPrinter[st]) service.stationToPrinter[st] = first;
  return { service, printers, cfg, printerId: first };
}

/** Wait for every printer queue to finish. */
export const drain = (printers) => Promise.all([...printers.values()].map((p) => p.queue.onIdle()));

/** Prompt the user and wait for Enter. */
export function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, () => { rl.close(); resolve(); });
  });
}

export const hr = (s = '') => console.log(`\n${'─'.repeat(60)}${s ? ' ' + s : ''}`);
