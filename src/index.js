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
const app = createHttpApp(service, { shopName: cfg.shop.name, apiKey: cfg.auth.token });

if (!cfg.auth.token) log.warn('AUTH DISABLED — /print is open to anyone on the network. Set PRINT_API_KEY to require a token.');

// Optional snackk inbound: subscribe outbound to its station SSE feeds. Only
// starts when SNACKK_URL + SNACKK_DEVICE_KEY are set — otherwise the HTTP inbound
// is the only path. A bad URL/key throws here, failing the boot loudly.
let snackk = null;
if (cfg.snackk.url && cfg.snackk.deviceKey) {
  // The snackk inbound is best-effort: startSnackkAgent no longer throws for a
  // disabled/unreachable tenant, but guard anyway so NOTHING about the optional
  // upstream can ever stop the local HTTP inbound from listening below.
  try {
    snackk = await startSnackkAgent({
      baseUrl: cfg.snackk.url,
      deviceKey: cfg.snackk.deviceKey,
      service,
      stations: cfg.snackk.stations,
      log,
    });
  } catch (err) {
    log.error('snackk integration failed to start — continuing with local HTTP inbound only', { error: String(err.message || err) });
  }
} else {
  log.info('snackk integration off (set SNACKK_URL + SNACKK_DEVICE_KEY to enable)');
}

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
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
