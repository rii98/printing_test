/**
 * In-memory transport for tests. Records every buffer sent, and can simulate the
 * two distinct failure modes the real TCP transport reports:
 *   • an OUTAGE (printer unreachable)  -> error tagged kind:'offline'
 *   • a REACHABLE printer rejecting the transfer -> error tagged kind:'io'
 * plus N untagged transient blips before recovering.
 *
 * `online` is a live, mutable field so a test can flip a printer back on mid-drain.
 */

/**
 * @param {{online?:boolean, failFirst?:number, rejectWrites?:boolean}} [opts]
 *   online       — when false, send() fails as kind:'offline' (unreachable).
 *   rejectWrites — when true (and online), send() fails as kind:'io' (poison).
 *   failFirst    — untagged transient failures before the printer recovers.
 */
export function fakeTransport({ online = true, failFirst = 0, rejectWrites = false } = {}) {
  const sent = [];
  let remainingFailures = failFirst;
  const tagged = (msg, kind) => { const e = new Error(msg); e.kind = kind; return e; };
  const t = {
    online,
    rejectWrites,
    sent,
    describe: 'fake://printer',
    async send(bytes) {
      if (!t.online) throw tagged('fake printer offline', 'offline');
      if (t.rejectWrites) throw tagged('fake printer rejected write', 'io');
      if (remainingFailures > 0) { remainingFailures--; throw new Error('fake transient failure'); }
      sent.push(Buffer.from(bytes));
    },
    async probe() { return t.online; },
  };
  return t;
}
