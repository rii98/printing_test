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

test('/health stays open for probes even with a key set', async () => {
  await withServer(createHttpApp(stubService(), { apiKey: 'k', shopName: 'X' }), async (base) => {
    const res = await fetch(base + '/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.shop, 'X');
  });
});
