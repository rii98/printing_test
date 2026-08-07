import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { tcpTransport } from '../src/adapters/transport/tcp.js';

// Start a throwaway TCP server on an ephemeral port; hand back its port + a close().
function listen(onConn) {
  return new Promise((resolve) => {
    const server = net.createServer(onConn);
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: (cb) => server.close(cb) }));
  });
}

test('send() delivers the bytes and resolves against a live printer', async () => {
  const chunks = [];
  const srv = await listen((sock) => { sock.on('data', (d) => chunks.push(d)); sock.on('end', () => sock.end()); });
  try {
    const t = tcpTransport({ host: '127.0.0.1', port: srv.port });
    await t.send(Buffer.from('RECEIPT'));
    // Give the server a tick to flush the last chunk before asserting.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(Buffer.concat(chunks).toString(), 'RECEIPT');
  } finally { srv.close(); }
});

test('an unreachable printer fails as kind:"offline" (never dead-lettered upstream)', async () => {
  // Bind then immediately release a port so nothing is listening -> ECONNREFUSED.
  const srv = await listen(() => {});
  const deadPort = srv.port;
  await new Promise((r) => srv.close(r));

  const t = tcpTransport({ host: '127.0.0.1', port: deadPort, connectTimeoutMs: 500 });
  await assert.rejects(t.send(Buffer.from('x')), (err) => {
    assert.equal(err.kind, 'offline', 'connect failure is classified as an outage');
    return true;
  });
});

test('a connect that never completes times out as kind:"offline"', async () => {
  // 10.255.255.1 is non-routable on a normal LAN, so connect stalls -> guard fires.
  const t = tcpTransport({ host: '10.255.255.1', port: 9100, connectTimeoutMs: 150 });
  await assert.rejects(t.send(Buffer.from('x')), (err) => {
    assert.equal(err.kind, 'offline');
    assert.match(err.message, /connect timeout/);
    return true;
  });
});
