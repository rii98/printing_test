import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfigClient } from '../src/inbound/snackk/config.js';

const NOLOG = { info() {}, warn() {} };
const CFG = { stationDelivery: 'both', orderRoutingMode: 'direct' };

test('start() caches the first config and exposes it via get()', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => CFG });
  const c = createConfigClient({ baseUrl: 'http://x', deviceKey: 'k', fetchImpl, log: NOLOG });
  await c.start();
  assert.deepEqual(c.get(), CFG);
  c.stop();
});

test('start() never throws when printing is disabled (404) — the appliance stays up', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const c = createConfigClient({ baseUrl: 'http://x', deviceKey: 'k', fetchImpl, log: NOLOG });
  // Must resolve, not reject: a not-yet-enabled tenant must not crash the local
  // HTTP inbound. get() stays null until the config comes good.
  await assert.doesNotReject(() => c.start());
  assert.equal(c.get(), null);
  c.stop();
});

test('start() never throws on a rejected key (401) either', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const c = createConfigClient({ baseUrl: 'http://x', deviceKey: 'k', fetchImpl, log: NOLOG });
  await assert.doesNotReject(() => c.start());
  assert.equal(c.get(), null);
  c.stop();
});

test('a later refresh failure keeps the last good config, never nulls it', async () => {
  let ok = true;
  const fetchImpl = async () =>
    ok ? { ok: true, json: async () => CFG } : { ok: false, status: 500, json: async () => ({}) };
  const c = createConfigClient({ baseUrl: 'http://x', deviceKey: 'k', refreshMs: 5, fetchImpl, log: NOLOG });
  await c.start();
  ok = false;
  await new Promise((r) => setTimeout(r, 20)); // let a refresh tick fail
  assert.deepEqual(c.get(), CFG, 'a blip must never silently switch printing off');
  c.stop();
});
