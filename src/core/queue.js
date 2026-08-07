/**
 * PrinterQueue — one per physical printer. Guarantees:
 *   • Serial: exactly one job on the wire at a time (port 9100 allows one).
 *   • FIFO: tickets print in the order accepted.
 *   • Durable: every job is persisted before it's acknowledged; a crash mid-print
 *     recovers on boot via recover().
 *   • Fault-tolerant: transient failures (printer offline, timeout) retry with
 *     capped exponential backoff + jitter; after maxAttempts a job is moved to the
 *     dead-letter store (never silently dropped) and the line keeps moving.
 *
 * Time is injected (sleep/now) so tests run instantly and deterministically.
 */

const DEFAULTS = {
  maxAttempts: 8,       // spans a multi-minute outage before dead-lettering
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

/** exponential backoff with full jitter */
export function backoff(attempt, { baseDelayMs, maxDelayMs }, rand = Math.random) {
  const raw = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(rand() * raw);
}

export class PrinterQueue {
  /**
   * @param {Object} o
   * @param {string} o.printerId
   * @param {import('../adapters/transport/tcp.js').Transport} o.transport
   * @param {any} o.store
   * @param {(evt:any)=>void} [o.onEvent]
   * @param {(ms:number)=>Promise<void>} [o.sleep]
   * @param {()=>number} [o.now]
   * @param {Partial<typeof DEFAULTS>} [o.policy]
   */
  constructor({ printerId, transport, store, onEvent = () => {}, sleep, now = Date.now, policy = {} }) {
    this.printerId = printerId;
    this.transport = transport;
    this.store = store;
    this.onEvent = onEvent;
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = now;
    this.policy = { ...DEFAULTS, ...policy };
    /** @type {any[]} */ this.jobs = [];
    this.draining = false;
    this.healthy = true;
    this._idleWaiters = [];
  }

  /** Emit an event without ever letting a throwing consumer break the drain loop. */
  _emit(evt) {
    try { this.onEvent(evt); } catch { /* an observer's failure is not a print failure */ }
  }

  /**
   * Run a durable-bookkeeping op that must NOT be able to trigger a re-print.
   * A store failure here is retried a few times (a transient blip — brief EIO,
   * a momentary lock — must not leave a ghost pending record that reprints on
   * the next restart), then reported and swallowed rather than rethrown into the
   * drain loop, because the delivery decision has already been made. Only a
   * *persistent* store failure gives up; the worst case then is a reprint on the
   * next restart, which is the safe direction — a duplicate over a lost receipt —
   * and it is surfaced loudly for operators.
   */
  async _safely(fn, op, jobId, attempts = 3) {
    for (let i = 1; i <= attempts; i++) {
      try { await fn(); return; }
      catch (err) {
        if (i === attempts) {
          this._emit({ type: 'store-error', printerId: this.printerId, jobId, op, error: String(err.message || err) });
          return;
        }
        await this.sleep(Math.min(1000, 50 * i));
      }
    }
  }

  /** Load persisted jobs after a restart and resume draining. */
  async recover() {
    const persisted = (await this.store.list()).filter((j) => j.printerId === this.printerId);
    this.jobs.push(...persisted);
    if (persisted.length) this._emit({ type: 'recovered', printerId: this.printerId, count: persisted.length });
    this._kick();
  }

  /**
   * Accept a job: persist first (so it survives a crash), then queue + drain.
   * @param {{id:string, key?:string, bytes:Buffer, label?:string}} job
   */
  async enqueue(job) {
    const record = {
      id: job.id,
      key: job.key ?? job.id,
      printerId: this.printerId,
      bytes: Buffer.from(job.bytes).toString('base64'),
      label: job.label ?? '',
      attempts: 0,
      createdAt: this.now(),
    };
    await this.store.add(record);          // durable BEFORE ack
    this.jobs.push(record);
    this._emit({ type: 'queued', printerId: this.printerId, jobId: record.id, label: record.label });
    this._kick();
  }

  get depth() { return this.jobs.length; }

  /** Resolves when the queue has fully drained (for tests / graceful shutdown). */
  onIdle() {
    if (!this.draining && this.jobs.length === 0) return Promise.resolve();
    return new Promise((resolve) => this._idleWaiters.push(resolve));
  }

  /** Fire-and-forget drain trigger. Defensive: the loop is written not to throw,
   *  but if it ever did, an unhandled rejection must not take down the process. */
  _kick() {
    this._drain().catch((err) =>
      this._emit({ type: 'store-error', printerId: this.printerId, op: 'drain', error: String(err.message || err) }));
  }

  async _drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.jobs.length) {
        const job = this.jobs[0];

        // --- Phase 1: delivery. This is the ONLY retryable, side-effecting step.
        // Decoding bytes is part of "can we deliver this?", so a corrupt payload
        // fails here and eventually dead-letters instead of crashing the loop.
        let sent = false, sendErr;
        try {
          await this.transport.send(Buffer.from(job.bytes, 'base64'));
          sent = true;
        } catch (err) {
          sendErr = err;
        }

        // --- Phase 2: record the outcome. Nothing here may cause a re-send, and
        // no failure here may escape the loop (see _safely / _emit).
        if (sent) {
          this.jobs.shift();
          await this._safely(() => this.store.remove(job.id), 'remove', job.id);
          if (!this.healthy) { this.healthy = true; this._emit({ type: 'online', printerId: this.printerId }); }
          this._emit({ type: 'sent', printerId: this.printerId, jobId: job.id, label: job.label, attempts: job.attempts + 1 });
          continue;
        }

        job.attempts += 1;
        const error = String(sendErr?.message || sendErr);
        // An 'offline' failure means we never reached the printer — a shared
        // outage (unplugged, rebooting, network down) that hits EVERY job equally,
        // not a fault of this one. Counting it toward dead-lettering would quietly
        // discard receipts during a blip, so offline failures retry indefinitely
        // with capped backoff and hold the whole queue in order. Only a failure
        // while the printer is reachable — or any unclassified fault (e.g. a corrupt
        // payload) — increments the dead-letter budget, which keeps the line moving
        // past a genuine poison job. This is the fix for the outage dead-letter storm.
        const offline = sendErr?.kind === 'offline';
        if (!offline) job.hardFailures = (job.hardFailures ?? 0) + 1;
        if (this.healthy) { this.healthy = false; this._emit({ type: 'offline', printerId: this.printerId, error }); }
        if (!offline && job.hardFailures >= this.policy.maxAttempts) {
          this.jobs.shift();
          await this._safely(() => this.store.kill(job), 'kill', job.id);
          this._emit({ type: 'dead', printerId: this.printerId, jobId: job.id, label: job.label, attempts: job.attempts, hardFailures: job.hardFailures, error });
        } else {
          await this._safely(() => this.store.update(job), 'update', job.id);
          const delay = backoff(job.attempts, this.policy);
          this._emit({ type: 'retry', printerId: this.printerId, jobId: job.id, attempts: job.attempts, delay, error, offline });
          await this.sleep(delay);
        }
      }
    } finally {
      this.draining = false;
      const waiters = this._idleWaiters; this._idleWaiters = [];
      for (const w of waiters) w();
    }
  }
}
