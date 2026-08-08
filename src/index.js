/**
 * Entrypoint: config -> service -> HTTP server, with graceful shutdown that
 * drains in-flight prints. Start with `npm start`.
 */
import os from 'node:os';
import { loadConfig } from './config.js';
import { buildService } from './bootstrap.js';
import { createHttpApp } from './inbound/http.js';
import { startSnackkAgent } from './inbound/snackk/subscribe.js';
import { createGracefulShutdown } from './shutdown.js';
import { log } from './logger.js';

const cfg = loadConfig();
const { service, printers } = await buildService(cfg);

// Assigned asynchronously below, once the snackk agent finishes starting. It is
// read lazily by /health and by shutdown, so the local HTTP inbound never waits
// on it — a slow or hanging cloud endpoint must not delay binding the port.
let snackk = null;
const snackkConfigured = Boolean(cfg.snackk.url && cfg.snackk.deviceKey);
const app = createHttpApp(service, {
  shopName: cfg.shop.name,
  apiKey: cfg.auth.token,
  // Until the agent handle resolves (its first config fetch, ≤15s), report
  // "starting" rather than "off" so /health never misleads during boot.
  snackkStatus: () => snackk?.status() ?? { enabled: snackkConfigured, state: snackkConfigured ? 'starting' : 'off' },
});

if (!cfg.auth.token) log.warn('AUTH DISABLED — /print is open to anyone on the network. Set PRINT_API_KEY to require a token.');

// Bind the local HTTP inbound FIRST — before touching the optional cloud upstream
// — so "local printing always works" holds even if snackk is unreachable or its
// config endpoint hangs. (Previously boot awaited startSnackkAgent → config.start
// → fetch; a hung fetch would block this listen forever.)
const server = app.listen(cfg.http.port, '0.0.0.0', () => {
  log.info(`print-agent listening on :${cfg.http.port}`, { store: cfg.store?.dir ?? 'memory' });
  for (const a of Object.values(os.networkInterfaces()).flat())
    if (a && a.family === 'IPv4' && !a.internal) log.info(`  devices POST -> http://${a.address}:${cfg.http.port}/print`);
});

const shutdown = createGracefulShutdown({
  server,
  queues: [...printers.values()].map((p) => p.queue),
  graceMs: cfg.shutdown.graceMs,
  onStop: () => snackk?.stop(),
  log,
});

// Optional snackk inbound: subscribe outbound to its station SSE feeds. Only
// starts when SNACKK_URL + SNACKK_DEVICE_KEY are set. Started in the BACKGROUND
// (not awaited) so nothing about the optional upstream — a slow config fetch, a
// not-yet-enabled tenant — can ever delay or block the HTTP inbound above.
if (cfg.snackk.url && cfg.snackk.deviceKey) {
  startSnackkAgent({
    baseUrl: cfg.snackk.url,
    deviceKey: cfg.snackk.deviceKey,
    service,
    stations: cfg.snackk.stations,
    log,
  }).then((handle) => { snackk = handle; })
    .catch((err) => log.error('snackk integration failed to start — continuing with local HTTP inbound only', { error: String(err.message || err) }));
} else {
  log.info('snackk integration off (set SNACKK_URL + SNACKK_DEVICE_KEY to enable)');
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
