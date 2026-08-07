/**
 * Durable, file-backed idempotency. Implements the same contract as
 * memoryIdempotency (src/core/idempotency.js) so the service is unaware which
 * one it holds — swap this for Redis/SQL later and nothing else changes.
 *
 * Two layers, deliberately kept apart:
 *   • reserved  — in-memory only. A key claimed by reserve() but not yet durably
 *                 accepted. This is what makes reserve() atomic (synchronous),
 *                 and it is NEVER written to disk (an unaccepted ticket must not
 *                 look "already printed" after a crash — that would LOSE a print).
 *   • committed — the durable, bounded FIFO of keys we truly accepted. Persisted
 *                 to seen.json and reloaded on boot. This is what survives a
 *                 restart so a re-sent ticket is recognized as a duplicate.
 *
 * Writes are atomic (temp file + rename) and serialized through a single promise
 * chain, so concurrent commits can never interleave into a torn or stale file.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * @param {string} dir   directory to hold seen.json (typically the queue store dir)
 * @param {{limit?:number}} [opts]  how many committed keys to retain (oldest evicted)
 * @returns {Promise<import('../../core/idempotency.js').Idempotency>}
 */
export async function fileIdempotency(dir, { limit = 10_000 } = {}) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'seen.json');

  /** keys claimed but not yet durably accepted (in-memory only) */
  const reserved = new Set();
  /** durable, bounded window of accepted keys */
  const committed = new Set();
  const order = [];

  const commitKey = (key) => {
    reserved.delete(key);
    if (committed.has(key)) return;
    committed.add(key);
    order.push(key);
    while (order.length > limit) committed.delete(order.shift());
  };

  // Load the durable window from a previous run.
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    if (Array.isArray(raw)) for (const k of raw) if (typeof k === 'string') commitKey(k);
  } catch { /* missing or corrupt file -> start empty */ }

  // Serialized atomic snapshot writer. Each call flushes the CURRENT committed
  // window; chaining guarantees renames land in order (no lost updates).
  let tail = Promise.resolve();
  const writeSnapshot = async () => {
    const snapshot = JSON.stringify(order);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, snapshot);
    await fs.rename(tmp, file);
  };
  const persist = () => (tail = tail.then(writeSnapshot, writeSnapshot));

  return {
    // Synchronous + atomic: true only for the first caller of an unseen key.
    reserve(key) {
      if (reserved.has(key) || committed.has(key)) return false;
      reserved.add(key);
      return true;
    },
    // Durably accept a reserved key and flush.
    commit(key) { commitKey(key); return persist(); },
    // Release a reservation that never became durable (nothing on disk to undo).
    rollback(key) { reserved.delete(key); },
    // Boot hydration: fold in keys already known to be accepted (recovered jobs).
    seed(keys) {
      let changed = false;
      for (const k of keys) if (!committed.has(k)) { commitKey(k); changed = true; }
      return changed ? persist() : Promise.resolve();
    },
  };
}
