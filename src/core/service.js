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
import { memoryIdempotency } from './idempotency.js';

export class PrintService {
  /**
   * @param {Object} o
   * @param {Map<string, {queue:import('./queue.js').PrinterQueue, width:number, encoding?:string, cut?:boolean, docKind?:string}>} o.printers  keyed by printerId
   * @param {Record<string,string>} o.stationToPrinter  station -> printerId
   * @param {{shopName?:string, shopLines?:string[]}} [o.branding]
   * @param {import('./idempotency.js').Idempotency} [o.idempotency]
   * @param {(evt:any)=>void} [o.onEvent]
   */
  constructor({ printers, stationToPrinter, branding = {}, idempotency = memoryIdempotency(), onEvent = () => {} }) {
    this.printers = printers;
    this.stationToPrinter = stationToPrinter;
    this.branding = branding;
    this.idem = idempotency;
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

    // Resolve the target before reserving, so a misrouted ticket never consumes
    // an idempotency slot (and can be legitimately re-sent once routing is fixed).
    const printerId = this.stationToPrinter[ticket.station];
    const printer = printerId && this.printers.get(printerId);
    if (!printer) {
      const error = `no printer configured for station "${ticket.station}"`;
      this.onEvent({ type: 'error', error });
      return { status: 'error', error };
    }

    // Atomic gate: reserve() decides in one synchronous tick, so two concurrent
    // identical requests can never both pass. Everything from here to enqueue()
    // is synchronous — no await can interleave a second request in between.
    const key = ticketKey(ticket);
    if (!this.idem.reserve(key)) {
      this.onEvent({ type: 'duplicate', key });
      return { status: 'duplicate', ticket: key };
    }

    const docKind = printer.docKind ?? STATION_DOC[ticket.station];
    const doc = renderTicket(ticket, { docKind, branding: this.branding });
    const bytes = encode(doc, { width: printer.width, encoding: printer.encoding ?? 'latin1', cut: printer.cut !== false, cutFeed: printer.cutFeed });

    try {
      await printer.queue.enqueue({ id: key, key, bytes, label: `${ticket.station}#${ticket.number ?? ''}` });
    } catch (err) {
      // The ticket was never durably accepted — free the key so a retry can print.
      await this.idem.rollback(key);
      const error = String(err.message || err);
      this.onEvent({ type: 'error', error });
      return { status: 'error', error };
    }
    // Durably remember the key (no-op for the in-memory implementation).
    await this.idem.commit(key);
    return { status: 'queued', ticket: key, printer: printerId };
  }

  /** Health snapshot for the /health endpoint. */
  health() {
    const printers = {};
    for (const [id, p] of this.printers) printers[id] = { healthy: p.queue.healthy, depth: p.queue.depth, transport: p.queue.transport.describe };
    return { printers };
  }
}
