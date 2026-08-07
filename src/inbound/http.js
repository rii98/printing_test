/**
 * HTTP inbound adapter. This is how devices (or a dev script) push tickets today.
 * When we integrate with snackk this file is replaced/augmented by an SSE
 * subscriber that calls the exact same service.print() — the core doesn't change.
 */
import express from 'express';

/**
 * @param {import('../core/service.js').PrintService} service
 * @param {{shopName?:string}} [meta]
 */
export function createHttpApp(service, meta = {}) {
  const app = express();
  app.use(express.json({ limit: '512kb' }));

  // Liveness + per-printer health/queue depth.
  app.get('/health', (req, res) => res.json({ ok: true, shop: meta.shopName, ...service.health() }));

  // Print one ticket. Body = neutral Ticket (see src/core/domain.js).
  app.post('/print', async (req, res) => {
    const result = await service.print(req.body);
    const code = result.status === 'error' ? 400 : 200;
    res.status(code).json(result);
  });

  // Print many at once (e.g. an order that fans out to several stations).
  app.post('/print-batch', async (req, res) => {
    const list = Array.isArray(req.body) ? req.body : [];
    const results = [];
    for (const t of list) results.push(await service.print(t));
    res.json({ results });
  });

  app.get('/', (req, res) => res.json({ service: 'print-agent', endpoints: ['/health', 'POST /print', 'POST /print-batch'] }));
  return app;
}
