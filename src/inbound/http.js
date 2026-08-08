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

// Express 4 does not forward a rejected async handler to the error middleware —
// the request would hang until the client times out. This adapter routes any
// rejection into next(err) so the terminal handler below turns it into JSON.
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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
 * @param {{shopName?:string, apiKey?:string|null, bodyLimit?:string,
 *   snackkStatus?:()=>any}} [meta]
 *   bodyLimit — max accepted request body (default 512kb); injectable for tests.
 *   snackkStatus — optional snapshot of the snackk SSE link for /health.
 */
export function createHttpApp(service, { shopName, apiKey, bodyLimit = '512kb', snackkStatus } = {}) {
  const app = express();
  app.use(express.json({ limit: bodyLimit }));
  const auth = requireApiKey(apiKey);

  // Liveness + per-printer health/queue depth, plus the snackk SSE link status
  // (connected? last event id? last byte/heartbeat? seed/reconnect counts?) so a
  // probe or an operator can see the agent is actually subscribed — not silently
  // wedged — without reading logs. `snackk` is absent when the integration is off.
  app.get('/health', (req, res) => {
    const snackk = snackkStatus?.() ?? { enabled: false };
    res.json({ ok: true, shop: shopName, ...service.health(), snackk });
  });

  // Print one ticket. Body = neutral Ticket (see src/core/domain.js).
  app.post('/print', auth, asyncRoute(async (req, res) => {
    const result = await service.print(req.body);
    const code = result.status === 'error' ? 400 : 200;
    res.status(code).json(result);
  }));

  // Print many at once (e.g. an order that fans out to several stations). The
  // HTTP status reflects the AGGREGATE so a caller that only checks the code is
  // never misled: 200 all accepted, 207 Multi-Status partial, 400 all failed.
  // A non-array body is a client mistake (400) — not a silent empty success.
  app.post('/print-batch', auth, asyncRoute(async (req, res) => {
    if (!Array.isArray(req.body)) {
      return res.status(400).json({ status: 'error', error: 'body must be a JSON array of tickets' });
    }
    const results = [];
    for (const t of req.body) results.push(await service.print(t));
    const errors = results.filter((r) => r.status === 'error').length;
    const code = errors === 0 ? 200 : errors === results.length ? 400 : 207;
    res.status(code).json({ results });
  }));

  app.get('/', (req, res) => res.json({ service: 'print-agent', endpoints: ['/health', 'POST /print', 'POST /print-batch'] }));

  // Terminal error handler. Two jobs: keep EVERY failure a uniform JSON envelope
  // (never Express's default HTML stack page — that both breaks JSON clients and
  // leaks internals), and translate the body parser's typed faults into precise,
  // safe client errors. Anything else stays an opaque 500. Must be registered
  // last, and must keep the 4-arg signature so Express treats it as error mware.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    const clientReasons = {
      'entity.parse.failed': 'invalid JSON body',
      'entity.too.large': 'payload too large',
      'charset.unsupported': 'unsupported charset',
      'encoding.unsupported': 'unsupported content encoding',
    };
    const error = status >= 500 ? 'internal error' : (clientReasons[err?.type] ?? 'bad request');
    res.status(status).json({ status: 'error', error });
  });
  return app;
}
