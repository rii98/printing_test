/**
 * HTTP inbound adapter. This is how devices (or a dev script) push tickets today.
 * When we integrate with snackk this file is replaced/augmented by an SSE
 * subscriber that calls the exact same service.print() — the core doesn't change.
 */
import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

// Constant-time secret comparison. Hashing first fixes the length to 32 bytes so
// timingSafeEqual never throws on a length mismatch and no length is leaked.
const digest = (s) => createHash('sha256').update(String(s ?? '')).digest();
const safeEqual = (a, b) => timingSafeEqual(digest(a), digest(b));

const bearer = (req) => {
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  return m ? m[1].trim() : null;
};

/**
 * Middleware guarding the mutating routes with a shared secret, supplied as
 * `Authorization: Bearer <key>` or `X-Api-Key: <key>`. With no key configured it
 * is a pass-through (unauthenticated mode) — index.js warns loudly at startup.
 * @param {string|null|undefined} apiKey
 */
export function requireApiKey(apiKey) {
  return (req, res, next) => {
    if (!apiKey) return next();
    const provided = bearer(req) || req.get('x-api-key');
    if (provided && safeEqual(provided, apiKey)) return next();
    res.status(401).json({ status: 'error', error: 'unauthorized' });
  };
}

/**
 * @param {import('../core/service.js').PrintService} service
 * @param {{shopName?:string, apiKey?:string|null}} [meta]
 */
export function createHttpApp(service, { shopName, apiKey } = {}) {
  const app = express();
  app.use(express.json({ limit: '512kb' }));
  const auth = requireApiKey(apiKey);

  // Liveness + per-printer health/queue depth. Left open for probes/monitors.
  app.get('/health', (req, res) => res.json({ ok: true, shop: shopName, ...service.health() }));

  // Print one ticket. Body = neutral Ticket (see src/core/domain.js).
  app.post('/print', auth, async (req, res) => {
    const result = await service.print(req.body);
    const code = result.status === 'error' ? 400 : 200;
    res.status(code).json(result);
  });

  // Print many at once (e.g. an order that fans out to several stations).
  app.post('/print-batch', auth, async (req, res) => {
    const list = Array.isArray(req.body) ? req.body : [];
    const results = [];
    for (const t of list) results.push(await service.print(t));
    res.json({ results });
  });

  app.get('/', (req, res) => res.json({ service: 'print-agent', endpoints: ['/health', 'POST /print', 'POST /print-batch'] }));
  return app;
}
