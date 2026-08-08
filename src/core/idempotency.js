/**
 * Idempotency — the single question "have we already accepted this exact ticket?"
 *
 * The contract that makes duplicates impossible is that **reserve() is
 * synchronous and atomic**: it decides in one tick, with no `await` between the
 * "have I seen this?" check and the "mark it seen" write. Two concurrent
 * identical requests therefore can never both win — the first reserves, every
 * other sees it already taken. (An async check-then-add can interleave across
 * the await and let both through; that was the original bug.)
 *
 * Durability — surviving a restart — is a property of the *implementation*, not
 * of this contract. The in-memory version below forgets on restart; a durable
 * version (see the file store) keeps the same synchronous reserve() but also
 * persists, so the two concerns stay cleanly separated.
 *
 * Lifecycle for one ticket:
 *   reserve(key) -> true   caller owns the key, must proceed
 *     ├─ accepted durably   -> commit(key)    // remember it for good
 *     └─ could not accept   -> rollback(key)  // free it so a retry can print
 *   reserve(key) -> false  someone already has it -> caller drops as duplicate
 *
 * @typedef {Object} Idempotency
 * @property {(key:string)=>boolean} reserve   Atomically claim a key. true = first time.
 * @property {(key:string)=>void|Promise<void>} commit    Confirm a reserved key is durably accepted.
 * @property {(key:string)=>void|Promise<void>} rollback  Release a reservation that never got accepted.
 * @property {(keys:string[])=>void|Promise<void>} seed   Mark keys already known to be accepted (boot hydration).
 * @property {(key:string)=>boolean} has   Has this key been durably ACCEPTED (committed), not merely reserved?
 *                                          Read-only; used to recover a VOID slip across a restart — a void
 *                                          prints only if its KOT's key is already accepted here.
 */

/**
 * In-memory idempotency with a bounded FIFO window. Fast and atomic, but NOT
 * durable across restarts — use the file-backed implementation for that.
 *
 * @param {number} [limit]  how many recent keys to remember (oldest evicted).
 * @returns {Idempotency}
 */
export function memoryIdempotency(limit = 5000) {
  /** @type {Set<string>} */ const seen = new Set();
  /** @type {string[]} */ const order = [];

  const forget = (key) => {
    if (!seen.delete(key)) return;
    const i = order.indexOf(key);
    if (i >= 0) order.splice(i, 1);
  };

  const remember = (key) => {
    if (seen.has(key)) return false;
    seen.add(key);
    order.push(key);
    while (order.length > limit) seen.delete(order.shift());
    return true;
  };

  return {
    reserve: remember,
    // In memory the reservation IS the record, so commit is a no-op. The durable
    // implementation overrides this to persist the key.
    commit() {},
    rollback(key) { forget(key); },
    seed(keys) { for (const k of keys) remember(k); },
    // In memory the reservation IS the record, so a reserved key already reads as
    // "seen". That is the safe direction for void recovery: at worst a VOID slip
    // prints for a KOT still mid-flight, never suppressed for one that did print.
    has(key) { return seen.has(key); },
  };
}
