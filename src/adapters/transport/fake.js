/**
 * In-memory transport for tests. Records every buffer sent, can simulate an
 * offline printer or N transient failures before recovering.
 */

/**
 * @param {{online?:boolean, failFirst?:number}} [opts]
 */
export function fakeTransport({ online = true, failFirst = 0 } = {}) {
  const sent = [];
  let remainingFailures = failFirst;
  const t = {
    online,
    sent,
    describe: 'fake://printer',
    async send(bytes) {
      if (!t.online) throw new Error('fake printer offline');
      if (remainingFailures > 0) { remainingFailures--; throw new Error('fake transient failure'); }
      sent.push(Buffer.from(bytes));
    },
    async probe() { return t.online; },
  };
  return t;
}
