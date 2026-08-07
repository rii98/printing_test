/**
 * TCP transport to a raw ESC/POS printer (port 9100). One short-lived connection
 * per job: connect, write, flush, close. Port 9100 accepts a single connection at
 * a time — the per-printer queue upstream guarantees we never open two at once.
 */
import net from 'node:net';

/**
 * @typedef {Object} Transport
 * @property {(bytes:Buffer)=>Promise<void>} send
 * @property {()=>Promise<boolean>} probe
 * @property {string} describe
 */

/**
 * @param {{host:string, port?:number, connectTimeoutMs?:number, writeTimeoutMs?:number}} cfg
 * @returns {Transport}
 */
export function tcpTransport({ host, port = 9100, connectTimeoutMs = 4000, writeTimeoutMs = 8000 }) {
  // Failures are tagged so the queue can tell a shared outage from a job fault:
  //   • kind:'offline' — we never reached the printer (refused/unreachable/connect
  //     timeout). This hits every job equally, so it must NOT count toward
  //     dead-lettering; the queue retries indefinitely and loses nothing.
  //   • kind:'io'      — we connected but the transfer failed (write error/timeout).
  //     This may be job-specific (a payload the printer chokes on), so it counts
  //     toward the dead-letter cap to keep the line moving.
  const send = (bytes) => new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false, connected = false, connectGuard;
    const fail = (msg, kind) => {
      if (settled) return; settled = true;
      clearTimeout(connectGuard);
      socket.destroy();
      const err = new Error(msg); err.kind = kind; reject(err);
    };
    const ok = () => {
      if (settled) return; settled = true;
      clearTimeout(connectGuard);
      socket.destroy();
      resolve();
    };
    // Inactivity timeout: before connect it's an outage, after connect it's I/O.
    socket.setTimeout(writeTimeoutMs, () => fail(`timeout to ${host}:${port}`, connected ? 'io' : 'offline'));
    socket.once('error', (e) => fail(`${e.code || e.message} to ${host}:${port}`, connected ? 'io' : 'offline'));
    socket.connect({ host, port }, () => {
      connected = true;
      socket.write(bytes, (err) => {
        if (err) return fail(`write failed to ${host}:${port}: ${err.message}`, 'io');
        // Give the printer a beat to drain, then close cleanly.
        socket.end(() => ok());
      });
    });
    // Guard the connect phase separately (connect has no own timeout by default).
    connectGuard = setTimeout(() => fail(`connect timeout to ${host}:${port}`, 'offline'), connectTimeoutMs);
  });

  const probe = () => new Promise((resolve) => {
    const socket = new net.Socket();
    let ok = false;
    const finish = (v) => { socket.destroy(); resolve(v); };
    socket.setTimeout(connectTimeoutMs, () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect({ host, port }, () => { ok = true; socket.end(); });
    socket.once('close', () => finish(ok));
  });

  return { send, probe, describe: `tcp://${host}:${port}` };
}
