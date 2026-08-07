/**
 * Graceful shutdown, bounded by a grace period.
 *
 * Draining is best-effort, not unbounded: if a printer is offline the queue sits
 * in backoff and onIdle() would not resolve for minutes, past any orchestrator's
 * SIGTERM grace — so we'd be SIGKILLed mid-shutdown anyway. Instead we race the
 * drain against a fixed grace window; whatever hasn't drained is already durable
 * on disk and resumes on the next boot, so exiting is safe.
 *
 * A second signal (an impatient operator hitting Ctrl-C twice) forces an
 * immediate exit rather than starting a second drain.
 *
 * All side-effecting deps are injected, so this is unit-testable without a real
 * server, real timers, or actually exiting the process.
 *
 * @param {Object} o
 * @param {{close?:()=>void}} [o.server]
 * @param {Array<{onIdle:()=>Promise<any>, depth?:number}>} o.queues
 * @param {number} [o.graceMs]
 * @param {{info:Function, warn:Function}} o.log
 * @param {(code:number)=>void} [o.exit]
 * @param {(cb:()=>void, ms:number)=>any} [o.setTimer]
 * @returns {(signal:string)=>Promise<void>}
 */
export function createGracefulShutdown({ server, queues, graceMs = 10_000, log, exit = (c) => process.exit(c), setTimer = setTimeout }) {
  let started = false;
  return async function shutdown(signal) {
    if (started) { log.warn(`${signal} again — forcing immediate exit`); return exit(1); }
    started = true;
    log.info(`${signal} received — draining queues (grace ${graceMs}ms)…`);
    try { server?.close?.(); } catch { /* already closing */ }

    // Either resolution ends the wait; a rejecting onIdle is treated as drained
    // so a misbehaving queue can never wedge shutdown open.
    const drained = Promise.all(queues.map((q) => q.onIdle())).then(() => true, () => true);
    const timedOut = new Promise((resolve) => {
      const t = setTimer(() => resolve(false), graceMs);
      if (t && typeof t.unref === 'function') t.unref();   // don't keep the loop alive
    });

    if (await Promise.race([drained, timedOut])) {
      log.info('drained cleanly. bye.');
      return exit(0);
    }
    const remaining = queues.reduce((n, q) => n + (q.depth ?? 0), 0);
    log.warn(`grace expired — ${remaining} job(s) still queued (persisted; resume on restart)`);
    return exit(0);
  };
}
