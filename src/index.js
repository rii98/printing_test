/**
 * Entrypoint: config -> service -> HTTP server, with graceful shutdown that
 * drains in-flight prints. Start with `npm start`.
 */
import os from 'node:os';
import { loadConfig } from './config.js';
import { buildService } from './bootstrap.js';
import { createHttpApp } from './inbound/http.js';
import { log } from './logger.js';

const cfg = loadConfig();
const { service, printers } = await buildService(cfg);
const app = createHttpApp(service, { shopName: cfg.shop.name });

const server = app.listen(cfg.http.port, '0.0.0.0', () => {
  log.info(`print-agent listening on :${cfg.http.port}`, { store: cfg.store?.dir ?? 'memory' });
  for (const a of Object.values(os.networkInterfaces()).flat())
    if (a && a.family === 'IPv4' && !a.internal) log.info(`  devices POST -> http://${a.address}:${cfg.http.port}/print`);
});

async function shutdown(sig) {
  log.info(`${sig} received — draining queues…`);
  server.close();
  await Promise.all([...printers.values()].map((p) => p.queue.onIdle()));
  log.info('drained. bye.');
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
