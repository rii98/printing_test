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

  /** Load persisted jobs after a restart and resume draining. */
  async recover() {
    const persisted = (await this.store.list()).filter((j) => j.printerId === this.printerId);
    this.jobs.push(...persisted);
    if (persisted.length) this.onEvent({ type: 'recovered', printerId: this.printerId, count: persisted.length });
    this._drain();
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
    this.onEvent({ type: 'queued', printerId: this.printerId, jobId: record.id, label: record.label });
    this._drain();
  }

  get depth() { return this.jobs.length; }

  /** Resolves when the queue has fully drained (for tests / graceful shutdown). */
  onIdle() {
    if (!this.draining && this.jobs.length === 0) return Promise.resolve();
    return new Promise((resolve) => this._idleWaiters.push(resolve));
  }

  async _drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.jobs.length) {
        const job = this.jobs[0];
        const bytes = Buffer.from(job.bytes, 'base64');
        try {
          await this.transport.send(bytes);
          this.jobs.shift();
          await this.store.remove(job.id);
          if (!this.healthy) { this.healthy = true; this.onEvent({ type: 'online', printerId: this.printerId }); }
          this.onEvent({ type: 'sent', printerId: this.printerId, jobId: job.id, label: job.label, attempts: job.attempts + 1 });
        } catch (err) {
          job.attempts += 1;
          if (this.healthy) { this.healthy = false; this.onEvent({ type: 'offline', printerId: this.printerId, error: String(err.message || err) }); }
          if (job.attempts >= this.policy.maxAttempts) {
            this.jobs.shift();
            await this.store.kill(job);
            this.onEvent({ type: 'dead', printerId: this.printerId, jobId: job.id, label: job.label, attempts: job.attempts, error: String(err.message || err) });
          } else {
            await this.store.update(job);
            const delay = backoff(job.attempts, this.policy);
            this.onEvent({ type: 'retry', printerId: this.printerId, jobId: job.id, attempts: job.attempts, delay, error: String(err.message || err) });
            await this.sleep(delay);
          }
        }
      }
    } finally {
      this.draining = false;
      const waiters = this._idleWaiters; this._idleWaiters = [];
      for (const w of waiters) w();
    }
  }
}
