import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMac, parseMac, discoverPrinters, resolveHostMac, localIPv4s } from '../src/adapters/discovery/scan.js';

test('normalizeMac accepts every real-world shape and lowercases to colon form', () => {
  assert.equal(normalizeMac('AA:BB:CC:DD:EE:FF'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(normalizeMac('aa-bb-cc-dd-ee-ff'), 'aa:bb:cc:dd:ee:ff', 'Windows dash form');
  assert.equal(normalizeMac('2:1f:e0:13:19:28'), '02:1f:e0:13:19:28', 'macOS drops leading zeros');
  assert.equal(normalizeMac('aabb.ccdd.eeff'), 'aa:bb:cc:dd:ee:ff', 'Cisco dotted form');
  assert.equal(normalizeMac('aabbccddeeff'), 'aa:bb:cc:dd:ee:ff', 'bare 12 hex');
});

test('normalizeMac rejects non-MACs instead of producing a bogus key', () => {
  for (const bad of ['', 'xyz', 'aa:bb:cc:dd:ee', 'aa:bb:cc:dd:ee:ff:00', '12:34', null, undefined, 42]) {
    assert.equal(normalizeMac(bad), null, `${String(bad)} is not a MAC`);
  }
});

test('parseMac pulls the MAC out of Linux / macOS / Windows arp output', () => {
  assert.equal(parseMac('? (192.168.18.240) at 02:1f:e0:13:19:28 [ether] on eth0'), '02:1f:e0:13:19:28');
  assert.equal(parseMac('? (192.168.18.240) at 2:1f:e0:13:19:28 on en0 ifscope [ethernet]'), '02:1f:e0:13:19:28');
  assert.equal(parseMac('  192.168.18.240   02-1f-e0-13-19-28     dynamic'), '02:1f:e0:13:19:28');
  assert.equal(parseMac('no address here'), null);
});

test('resolveHostMac: MAC when the host answers, null when it does not', async () => {
  const up = await resolveHostMac('9.9.9.9', 9100, 1, { checkPort: async () => true, macFor: async () => 'aa:bb:cc:dd:ee:ff' });
  assert.equal(up, 'aa:bb:cc:dd:ee:ff');
  const down = await resolveHostMac('9.9.9.9', 9100, 1, { checkPort: async () => false, macFor: async () => { throw new Error('should not be called'); } });
  assert.equal(down, null);
  assert.equal(await resolveHostMac(null), null, 'no host -> null');
});

test('discoverPrinters probes hosts + subnet, de-duped, never scanning our own IPs', async () => {
  const probed = [];
  const checkPort = async (ip) => { probed.push(ip); return ip === '10.0.0.42'; };
  const macFor = async (ip) => (ip === '10.0.0.42' ? 'aa:bb:cc:dd:ee:ff' : null);
  const own = localIPv4s();
  const hosts = ['1.2.3.4', '1.2.3.4', '10.0.0.42', ...own];   // a dup, a sweep overlap, and our own IPs

  const found = await discoverPrinters({ subnet: '10.0.0', hosts, deps: { checkPort, macFor }, concurrency: 8, timeoutMs: 1 });

  assert.deepEqual(found, [{ ip: '10.0.0.42', mac: 'aa:bb:cc:dd:ee:ff' }]);
  assert.equal(probed.filter((x) => x === '1.2.3.4').length, 1, 'duplicate host probed once');
  assert.equal(probed.filter((x) => x === '10.0.0.42').length, 1, 'host that also falls in the sweep probed once');
  for (const ip of own) assert.ok(!probed.includes(ip), `own IP ${ip} is never scanned`);
  assert.ok(probed.includes('10.0.0.1') && probed.includes('10.0.0.254'), 'the /24 was swept');
});
