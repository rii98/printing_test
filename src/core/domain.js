/**
 * Neutral domain model. This is OURS — deliberately independent of snackk's
 * `OrderTicketDto`. When we integrate, one small adapter maps their DTO to this;
 * the whole core depends only on the shapes below, so nothing here is coupled to
 * any upstream system.
 *
 * @typedef {'kitchen'|'bar'|'cashier'} Station
 * @typedef {'kot'|'bot'|'bill'} DocKind
 *
 * @typedef {Object} TicketItem
 * @property {string} name
 * @property {number} [qty=1]
 * @property {number} [price]           Unit price (minor→major currency, e.g. 3.50). Omitted on KOT/BOT.
 * @property {number} [amount]          Trusted line total (major units). When set, the bill layout prints
 *                                      it verbatim instead of computing qty×price — used when an upstream
 *                                      (snackk) owns the line math incl. modifiers/rounding.
 * @property {number} [rate]            Trusted per-unit amount as PRINTED (major units). When every
 *                                      line of a bill carries one, the bill prints the
 *                                      `Item | Qty | Rate | Amount` table (a tax invoice's lines,
 *                                      before VAT); otherwise the legacy `2x Name  amount` rows.
 * @property {string[]} [modifiers]     e.g. ["No onion", "Extra spicy"]
 * @property {string} [note]            Free text for the line.
 * @property {boolean} [voided]         A single line pulled before prep.
 *
 * @typedef {Object} Ticket
 * @property {string} id                Stable unique id — the idempotency key.
 * @property {number} [revision=0]      Bumps when the ticket changes; (id,revision) prints once.
 * @property {number} [number]          Human-facing ticket number.
 * @property {Station} station          Which station this ticket is for.
 * @property {'dine-in'|'takeaway'|'delivery'} [orderType]
 * @property {string} [table]
 * @property {string} [server]          Waiter/staff name.
 * @property {string|Date} [placedAt]
 * @property {TicketItem[]} items
 * @property {boolean} [voided]         Whole-ticket cancellation → prints a VOID slip.
 * @property {string} [voidReason]
 * // bill-only fields:
 * @property {number} [discount]        Positive number subtracted from subtotal.
 * @property {number} [taxRate]         e.g. 0.13 for 13% VAT.
 * @property {string} [taxLabel]        e.g. "VAT 13%".
 * @property {number} [serviceCharge]   Positive number added.
 * @property {number} [total]           If given, trusted verbatim; else computed.
 * @property {{subtotal:number, discount:number, service:number, tax:number, total:number, taxable?:number}} [totals]
 *                                      Trusted breakdown (major units). `taxable` (the VAT base) is
 *                                      optional; when present the plain slip prints "Taxable amount"
 *                                      above the tax, as the browser receipt does. When set, the bill layout renders
 *                                      these verbatim and does NOT recompute from item prices — for bills
 *                                      whose money an upstream owns (snackk: VAT-inclusive/promotions/udharo).
 * @property {string} [discountLabel]   The discount row's label, e.g. "Friday Spin (20%)". Default "Discount".
 * @property {string} [serviceLabel]    The service-charge row's label, e.g. "Service charge (10%)".
 * @property {string[]} [notes]         Centered lines under the totals, e.g. "Menu prices include 13% VAT."
 * @property {string} [currency]        e.g. "Rs", "$". Default from config.
 * @property {string} [payment]         e.g. "Cash", "Card", "eSewa". Legacy single-line tender;
 *                                      `payments` wins when both are present.
 * @property {FiscalPayment[]} [payments]  How the bill was paid, one row per tender — printed on the
 *                                      PLAIN slip. A fiscal receipt prints `fiscal.payments` instead
 *                                      (read from the tax document), never both.
 * @property {string} [shopName]        The issuer's name, carried WITH the bill so the receipt
 *                                      can't be handed the wrong one (falls back to config branding).
 * @property {string[]} [shopLines]     Sub-header lines under the name (e.g. "PAN 123456789").
 * @property {Fiscal} [fiscal]          Legal-document facts for a tax-invoice receipt (see below).
 * @property {number} [copyOf]          A reprint's copy number (>0). Prints a "COPY OF ORIGINAL"
 *                                      banner; distinct from the original settle print (copy 0).
 * @property {string} [footer]
 *
 * @typedef {Object} FiscalPayment
 * @property {string} label             Tender label as printed ("Cash", "Khalti", "Udharo").
 * @property {number} amount            Amount in major units.
 *
 * @typedef {Object} Fiscal
 * @property {string} [docTitle]        e.g. "ABBREVIATED TAX INVOICE".
 * @property {string} [invoiceNo]       The legal number, e.g. "2083/84-000042".
 * @property {string} [dateBs]          Bikram Sambat issue date.
 * @property {string} [dateAd]          Gregorian issue date.
 * @property {number} [taxable]         The VAT base (subtotal − discount + service), major units.
 * @property {FiscalPayment[]} [payments]  The tender split.
 * @property {{name?:string, address?:string, pan?:string}} [buyer]  The document's buyer.
 * @property {boolean} [buyerSlots]     Print all three buyer rows, blank when unknown — a full tax
 *                                      invoice's Schedule-5 slots. False: print only what is given.
 * @property {string} [qr]              QR payload (URL, invoice ref…).
 * @property {boolean} [openDrawer]     Kick the cash drawer after a bill.
 */

export const STATIONS = /** @type {const} */ (['kitchen', 'bar', 'cashier']);

/** Which layout a station prints by default. Overridable in config. */
export const STATION_DOC = /** @type {Record<Station,DocKind>} */ ({
  kitchen: 'kot',
  bar: 'bot',
  cashier: 'bill',
});

export class ValidationError extends Error {
  /** @param {string} msg */
  constructor(msg) { super(msg); this.name = 'ValidationError'; }
}

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isNonNegInt = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const cleanStr = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * Tolerant normalizer for a tender list (the plain slip's `payments` and the
 * fiscal block's). Same stance as the fiscal block: a malformed row is dropped,
 * never fatal — a bill that can't say how it was paid still prints. Returns
 * undefined when nothing usable survives, so the layout sees plain absence.
 * @param {any} raw
 * @returns {FiscalPayment[]|undefined}
 */
function normalizePayments(raw) {
  if (!Array.isArray(raw)) return undefined;
  const rows = raw
    .filter((p) => p && typeof p === 'object' && cleanStr(p.label) && isFiniteNum(p.amount))
    .map((p) => ({ label: p.label.trim(), amount: Number(p.amount) }));
  return rows.length ? rows : undefined;
}

/**
 * The document's buyer — each field optional, blanks dropped. Undefined when
 * nothing usable is left, so the layout sees plain absence.
 * @param {any} raw
 * @returns {{name?:string, address?:string, pan?:string}|undefined}
 */
function normalizeBuyer(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const buyer = { name: cleanStr(raw.name), address: cleanStr(raw.address), pan: cleanStr(raw.pan) };
  return Object.values(buyer).some((v) => v !== undefined) ? buyer : undefined;
}

/**
 * Tolerant normalizer for the OPTIONAL fiscal block on a cashier bill. Unlike the
 * core ticket fields, a malformed enrichment must NEVER reject the whole receipt —
 * a bill that can't carry its invoice number should still print as a plain slip.
 * So this coerces what it can and returns undefined for anything unusable, never
 * throwing. Only our own snackk adapter populates it, from a validated payload.
 * @param {any} raw
 * @returns {import('./domain.js').Fiscal|undefined}
 */
function normalizeFiscal(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const payments = normalizePayments(raw.payments);
  const fiscal = {
    docTitle: cleanStr(raw.docTitle),
    invoiceNo: cleanStr(raw.invoiceNo),
    dateBs: cleanStr(raw.dateBs),
    dateAd: cleanStr(raw.dateAd),
    taxable: isFiniteNum(raw.taxable) ? Number(raw.taxable) : undefined,
    payments,
    buyer: normalizeBuyer(raw.buyer),
    buyerSlots: raw.buyerSlots === true ? true : undefined,
  };
  // Drop the block entirely if nothing survived — the layout treats absence as
  // "plain receipt", so an empty husk would just print a bare title-less slip.
  return Object.values(fiscal).some((v) => v !== undefined) ? fiscal : undefined;
}

/**
 * Validate + normalize an untrusted ticket into a clean, defaulted Ticket.
 * Throws ValidationError with a precise message — never prints garbage.
 * @param {any} raw
 * @returns {Ticket}
 */
export function normalizeTicket(raw) {
  if (!raw || typeof raw !== 'object') throw new ValidationError('ticket must be an object');
  if (typeof raw.id !== 'string' || raw.id.trim() === '') throw new ValidationError('ticket.id (non-empty string) is required');
  if (!STATIONS.includes(raw.station)) throw new ValidationError(`ticket.station must be one of ${STATIONS.join(', ')}`);

  const voided = raw.voided === true;
  const items = Array.isArray(raw.items) ? raw.items : [];
  // A void slip needs no items; a normal ticket must have at least one.
  if (!voided && items.length === 0) throw new ValidationError('ticket.items must be a non-empty array');

  /** @type {TicketItem[]} */
  const normItems = items.map((it, i) => {
    if (!it || typeof it !== 'object') throw new ValidationError(`items[${i}] must be an object`);
    if (typeof it.name !== 'string' || it.name.trim() === '') throw new ValidationError(`items[${i}].name is required`);
    const qty = it.qty == null ? 1 : it.qty;
    if (!isFiniteNum(qty) || qty <= 0) throw new ValidationError(`items[${i}].qty must be a positive number`);
    if (it.price != null && (!isFiniteNum(it.price) || it.price < 0)) throw new ValidationError(`items[${i}].price must be >= 0`);
    if (it.amount != null && (!isFiniteNum(it.amount) || it.amount < 0)) throw new ValidationError(`items[${i}].amount must be a number >= 0`);
    if (it.rate != null && (!isFiniteNum(it.rate) || it.rate < 0)) throw new ValidationError(`items[${i}].rate must be a number >= 0`);
    return {
      name: it.name.trim(),
      qty,
      price: it.price != null ? Number(it.price) : undefined,
      amount: it.amount != null ? Number(it.amount) : undefined,
      rate: it.rate != null ? Number(it.rate) : undefined,
      modifiers: Array.isArray(it.modifiers) ? it.modifiers.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim()) : undefined,
      note: typeof it.note === 'string' && it.note.trim() ? it.note.trim() : undefined,
      voided: it.voided === true,
    };
  });

  for (const f of ['discount', 'taxRate', 'serviceCharge', 'total']) {
    if (raw[f] != null && (!isFiniteNum(raw[f]) || raw[f] < 0)) throw new ValidationError(`ticket.${f} must be a number >= 0`);
  }

  // revision and number are DISCRETE identifiers, not measurements. Reject a
  // non-integer or negative value rather than silently coercing it to a default:
  // the old `isFiniteNum(x) ? x : 0` turned a string "2" or a stray 1.5 into
  // revision 0, collapsing distinct revisions of a ticket into one idempotency
  // key — a real edit would then be dropped as a "duplicate" and never print.
  if (raw.revision != null && !isNonNegInt(raw.revision)) throw new ValidationError('ticket.revision must be a non-negative integer');
  if (raw.number != null && !isNonNegInt(raw.number)) throw new ValidationError('ticket.number must be a non-negative integer');

  // A trusted breakdown (all five figures) supplied by an upstream that owns the
  // money — validated whole, so a partial/garbage `totals` never half-prints.
  let totals;
  if (raw.totals != null) {
    if (typeof raw.totals !== 'object') throw new ValidationError('ticket.totals must be an object');
    for (const f of ['subtotal', 'discount', 'service', 'tax', 'total']) {
      if (!isFiniteNum(raw.totals[f]) || raw.totals[f] < 0) throw new ValidationError(`ticket.totals.${f} must be a number >= 0`);
    }
    // Optional sixth figure: validated the same way when present, never invented.
    const taxable = raw.totals.taxable;
    if (taxable != null && (!isFiniteNum(taxable) || taxable < 0)) throw new ValidationError('ticket.totals.taxable must be a number >= 0');
    totals = {
      subtotal: Number(raw.totals.subtotal),
      discount: Number(raw.totals.discount),
      service: Number(raw.totals.service),
      tax: Number(raw.totals.tax),
      total: Number(raw.totals.total),
      taxable: taxable != null ? Number(taxable) : undefined,
    };
  }

  return {
    id: raw.id.trim(),
    revision: raw.revision != null ? raw.revision : 0,
    number: raw.number != null ? raw.number : undefined,
    station: raw.station,
    orderType: ['dine-in', 'takeaway', 'delivery'].includes(raw.orderType) ? raw.orderType : undefined,
    table: typeof raw.table === 'string' ? raw.table : undefined,
    server: typeof raw.server === 'string' ? raw.server : undefined,
    placedAt: raw.placedAt ?? undefined,
    items: normItems,
    voided,
    voidReason: typeof raw.voidReason === 'string' ? raw.voidReason : undefined,
    discount: raw.discount != null ? Number(raw.discount) : undefined,
    taxRate: raw.taxRate != null ? Number(raw.taxRate) : undefined,
    taxLabel: typeof raw.taxLabel === 'string' ? raw.taxLabel : undefined,
    serviceCharge: raw.serviceCharge != null ? Number(raw.serviceCharge) : undefined,
    total: raw.total != null ? Number(raw.total) : undefined,
    totals,
    discountLabel: cleanStr(raw.discountLabel),
    serviceLabel: cleanStr(raw.serviceLabel),
    notes: Array.isArray(raw.notes)
      ? raw.notes.filter((l) => typeof l === 'string' && l.trim()).map((l) => l.trim())
      : undefined,
    currency: typeof raw.currency === 'string' ? raw.currency : undefined,
    payment: typeof raw.payment === 'string' ? raw.payment : undefined,
    payments: normalizePayments(raw.payments),
    shopName: cleanStr(raw.shopName),
    shopLines: Array.isArray(raw.shopLines)
      ? raw.shopLines.filter((l) => typeof l === 'string' && l.trim()).map((l) => l.trim())
      : undefined,
    fiscal: normalizeFiscal(raw.fiscal),
    // A reprint's copy number, for the "COPY OF ORIGINAL" banner. Cosmetic and
    // lenient — a bad value is dropped, never fatal (the idempotency key rides
    // `revision`, which is validated strictly above). Only a positive integer is
    // a copy; 0/absent is the original.
    copyOf: isNonNegInt(raw.copyOf) && raw.copyOf > 0 ? raw.copyOf : undefined,
    footer: typeof raw.footer === 'string' ? raw.footer : undefined,
    qr: typeof raw.qr === 'string' ? raw.qr : undefined,
    openDrawer: raw.openDrawer === true,
  };
}

/** The idempotency key for a ticket render. */
export const ticketKey = (/** @type {Ticket} */ t) => `${t.id}@${t.revision ?? 0}${t.voided ? ':void' : ''}`;
