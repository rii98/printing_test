import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpApp } from '../src/inbound/http.js';

// A stub service — the HTTP adapter must be testable without the real core.
const stubService = () => {
  const calls = [];
  return {
    calls,
    async print(t) { calls.push(t); return { status: 'queued', ticket: t?.id }; },
    health: () => ({ printers: {} }),
  };
};

// Boot the express app on an ephemeral port, run fn(baseUrl), always close.
const withServer = (app, fn) => new Promise((resolve, reject) => {
  const server = app.listen(0, async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    try { resolve(await fn(base)); } catch (e) { reject(e); } finally { server.close(); }
  });
});

const post = (base, path, body, headers = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

const ticket = { id: 't1', station: 'kitchen', items: [{ name: 'A', qty: 1 }] };

test('no key configured: /print is open (pass-through)', async () => {
  const svc = stubService();
  await withServer(createHttpApp(svc, {}), async (base) => {
    const res = await post(base, '/print', ticket);
    assert.equal(res.status, 200);
    assert.equal(svc.calls.length, 1);
  });
});

test('key configured: /print rejects a missing or wrong key with 401', async () => {
  const svc = stubService();
  await withServer(createHttpApp(svc, { apiKey: 'secret-123' }), async (base) => {
    const noKey = await post(base, '/print', ticket);
    assert.equal(noKey.status, 401);
    const wrong = await post(base, '/print', ticket, { authorization: 'Bearer nope' });
    assert.equal(wrong.status, 401);
    assert.equal(svc.calls.length, 0, 'service never invoked without a valid key');
  });
});

test('key configured: accepts Bearer and X-Api-Key', async () => {
  const svc = stubService();
  await withServer(createHttpApp(svc, { apiKey: 'secret-123' }), async (base) => {
    const bearer = await post(base, '/print', ticket, { authorization: 'Bearer secret-123' });
    assert.equal(bearer.status, 200);
    const apiKey = await post(base, '/print', ticket, { 'x-api-key': 'secret-123' });
    assert.equal(apiKey.status, 200);
    assert.equal(svc.calls.length, 2);
  });
});

test('/print-batch is guarded too', async () => {
  const svc = stubService();
  await withServer(createHttpApp(svc, { apiKey: 'k' }), async (base) => {
    assert.equal((await post(base, '/print-batch', [ticket])).status, 401);
    const ok = await post(base, '/print-batch', [ticket, ticket], { authorization: 'Bearer k' });
    assert.equal(ok.status, 200);
    assert.equal(svc.calls.length, 2);
  });
});

test('malformed JSON body returns uniform JSON error, not an HTML stack page', async () => {
  const svc = stubService();
  await withServer(createHttpApp(svc, {}), async (base) => {
    const res = await fetch(base + '/print', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ this is not valid json',
    });
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();
    assert.equal(body.status, 'error');
    assert.equal(body.error, 'invalid JSON body');
    assert.doesNotMatch(body.error, /SyntaxError|at |stack/i, 'no internals leaked');
    assert.equal(svc.calls.length, 0, 'a body that never parsed never reaches the service');
  });
});

test('oversized body is rejected as JSON (413), service untouched', async () => {
  const svc = stubService();
  // 1 KB cap so the test payload stays tiny; production uses 512 KB.
  await withServer(createHttpApp(svc, { bodyLimit: '1kb' }), async (base) => {
    const huge = { id: 'x', station: 'kitchen', items: [{ name: 'A'.repeat(4000), qty: 1 }] };
    const res = await post(base, '/print', huge);
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.status, 'error');
    assert.equal(body.error, 'payload too large');
    assert.equal(svc.calls.length, 0);
  });
});

test('an unexpected service rejection becomes a 500 JSON, not a hung request', async () => {
  // Even though the core service is written not to throw, the adapter must never
  // hang if it ever does — a rejected async handler has to land as JSON.
  const svc = { async print() { throw new Error('boom: secret internal detail'); }, health: () => ({ printers: {} }) };
  await withServer(createHttpApp(svc, {}), async (base) => {
    const res = await post(base, '/print', ticket);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.status, 'error');
    assert.equal(body.error, 'internal error', 'server faults stay opaque');
    assert.doesNotMatch(JSON.stringify(body), /secret internal detail/, 'no internals leaked');
  });
});

// A service whose verdict depends on the ticket id, to exercise batch aggregation.
const verdictService = (verdict) => ({
  async print(t) {
    const status = verdict(t);
    return status === 'error' ? { status: 'error', error: 'nope' } : { status, ticket: t?.id };
  },
  health: () => ({ printers: {} }),
});

test('/print-batch: all accepted -> 200', async () => {
  const svc = verdictService(() => 'queued');
  await withServer(createHttpApp(svc, {}), async (base) => {
    const res = await post(base, '/print-batch', [ticket, ticket]);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).results.length, 2);
  });
});

test('/print-batch: partial failure -> 207 Multi-Status', async () => {
  const svc = verdictService((t) => (t.id === 'bad' ? 'error' : 'queued'));
  await withServer(createHttpApp(svc, {}), async (base) => {
    const res = await post(base, '/print-batch', [{ ...ticket, id: 'ok' }, { ...ticket, id: 'bad' }]);
    assert.equal(res.status, 207);
    const body = await res.json();
    assert.deepEqual(body.results.map((r) => r.status), ['queued', 'error']);
  });
});

test('/print-batch: every item failed -> 400', async () => {
  const svc = verdictService(() => 'error');
  await withServer(createHttpApp(svc, {}), async (base) => {
    const res = await post(base, '/print-batch', [ticket, ticket]);
    assert.equal(res.status, 400);
  });
});

test('/print-batch: a non-array body is a 400, not a silent empty success', async () => {
  const svc = stubService();
  await withServer(createHttpApp(svc, {}), async (base) => {
    const res = await post(base, '/print-batch', { not: 'an array' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).status, 'error');
    assert.equal(svc.calls.length, 0);
  });
});

test('/health stays open for probes even with a key set', async () => {
  await withServer(createHttpApp(stubService(), { apiKey: 'k', shopName: 'X' }), async (base) => {
    const res = await fetch(base + '/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.shop, 'X');
  });
});
