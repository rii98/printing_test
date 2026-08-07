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
  const send = (bytes) => new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (err) => {
      if (settled) return; settled = true;
      socket.destroy();
      err ? reject(err) : resolve();
    };
    socket.setTimeout(writeTimeoutMs, () => done(new Error(`write timeout to ${host}:${port}`)));
    socket.once('error', done);
    socket.connect({ host, port }, () => {
      socket.write(bytes, (err) => {
        if (err) return done(err);
        // Give the printer a beat to drain, then close cleanly.
        socket.end(() => done());
      });
    });
    // Guard the connect phase separately (connect has no own timeout by default).
    const connectGuard = setTimeout(() => done(new Error(`connect timeout to ${host}:${port}`)), connectTimeoutMs);
    socket.once('connect', () => clearTimeout(connectGuard));
    socket.once('close', () => clearTimeout(connectGuard));
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
