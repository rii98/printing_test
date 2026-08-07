/**
 * PrintService — the one public entry point for "print this ticket". It:
 *   1. validates + normalizes the ticket,
 *   2. drops exact duplicates (idempotency by id@revision) — SSE replay-safe,
 *   3. routes station -> printer,
 *   4. renders the right layout to a Doc, encodes to that printer's width, and
 *   5. hands bytes to the printer's durable queue.
 *
 * It knows nothing about HTTP/SSE/TCP — those are adapters that call print().
 */
import { normalizeTicket, ticketKey, STATION_DOC } from './domain.js';
import { renderTicket } from './render/index.js';
import { encode } from './render/escpos.js';

/** A tiny in-memory idempotency set. Swap for a persisted one if desired. */
export function memoryDedup(limit = 5000) {
  const seen = new Set();
  const order = [];
  return {
    has: (k) => seen.has(k),
    add: (k) => { if (!seen.has(k)) { seen.add(k); order.push(k); if (order.length > limit) seen.delete(order.shift()); } },
  };
}

export class PrintService {
  /**
   * @param {Object} o
   * @param {Map<string, {queue:import('./queue.js').PrinterQueue, width:number, encoding?:string, cut?:boolean, docKind?:string}>} o.printers  keyed by printerId
   * @param {Record<string,string>} o.stationToPrinter  station -> printerId
   * @param {{shopName?:string, shopLines?:string[]}} [o.branding]
   * @param {{has:(k:string)=>boolean, add:(k:string)=>void}} [o.dedup]
   * @param {(evt:any)=>void} [o.onEvent]
   */
  constructor({ printers, stationToPrinter, branding = {}, dedup = memoryDedup(), onEvent = () => {} }) {
    this.printers = printers;
    this.stationToPrinter = stationToPrinter;
    this.branding = branding;
    this.dedup = dedup;
    this.onEvent = onEvent;
  }

  /**
   * @param {any} raw  untrusted ticket
   * @returns {Promise<{status:'queued'|'duplicate'|'error', ticket?:string, printer?:string, error?:string}>}
   */
  async print(raw) {
    let ticket;
    try {
      ticket = normalizeTicket(raw);
    } catch (err) {
      this.onEvent({ type: 'rejected', error: String(err.message || err) });
      return { status: 'error', error: String(err.message || err) };
    }

    const key = ticketKey(ticket);
    if (this.dedup.has(key)) {
      this.onEvent({ type: 'duplicate', key });
      return { status: 'duplicate', ticket: key };
    }

    const printerId = this.stationToPrinter[ticket.station];
    const printer = printerId && this.printers.get(printerId);
    if (!printer) {
      const error = `no printer configured for station "${ticket.station}"`;
      this.onEvent({ type: 'error', error });
      return { status: 'error', error };
    }

    const docKind = printer.docKind ?? STATION_DOC[ticket.station];
    const doc = renderTicket(ticket, { docKind, branding: this.branding });
    const bytes = encode(doc, { width: printer.width, encoding: printer.encoding ?? 'latin1', cut: printer.cut !== false, cutFeed: printer.cutFeed });

    await printer.queue.enqueue({ id: key, key, bytes, label: `${ticket.station}#${ticket.number ?? ''}` });
    this.dedup.add(key);
    return { status: 'queued', ticket: key, printer: printerId };
  }

  /** Health snapshot for the /health endpoint. */
  health() {
    const printers = {};
    for (const [id, p] of this.printers) printers[id] = { healthy: p.queue.healthy, depth: p.queue.depth, transport: p.queue.transport.describe };
    return { printers };
  }
}
