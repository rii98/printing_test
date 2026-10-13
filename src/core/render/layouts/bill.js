/**
 * Customer bill / receipt (cashier). Prices, subtotal, discount, service charge,
 * tax, grand total, payment method, QR, footer. Totals are computed from the
 * items unless the caller supplies an explicit `total` (then it's trusted).
 */
import { DocBuilder } from '../doc.js';
import { money } from '../format.js';
import { toMinor, fromMinor, applyRate } from '../../money.js';

const fmtTime = (v) => { try { return v ? new Date(v).toLocaleString() : ''; } catch { return ''; } };
// The true moment this copy came off the printer, en-GB so it reads dd/mm/yyyy —
// the same "Printed on …" stamp the browser invoice carries.
const fmtNow = () => { try { return new Date().toLocaleString('en-GB'); } catch { return ''; } };

/** A single line's charge, rounded to the minor unit exactly once. */
const lineMinor = (it) => toMinor((it.price ?? 0) * (it.qty ?? 1));

/**
 * Compute the money breakdown. Pure — unit-tested independently. All arithmetic
 * runs in integer minor units so the printed lines reconcile with the subtotal
 * and total to the paisa; the returned numbers are major units (unchanged shape).
 *
 * TRUSTED path: when the caller supplies `t.totals` (an upstream that owns the
 * money — snackk's VAT-inclusive / promotion / udharo math), those figures are
 * rendered VERBATIM and nothing is re-derived from item prices. Recomputing here
 * would mismatch snackk's total, and the printed receipt must equal the counter's.
 */
export function computeTotals(t) {
  const cur = t.currency ?? '';
  if (t.totals) {
    return {
      cur,
      subtotal: t.totals.subtotal,
      discount: t.totals.discount,
      service: t.totals.service,
      tax: t.totals.tax,
      total: t.totals.total,
    };
  }
  const subtotalMinor = t.items.filter((i) => !i.voided).reduce((s, i) => s + lineMinor(i), 0);
  const discountMinor = toMinor(t.discount ?? 0);
  const serviceMinor = toMinor(t.serviceCharge ?? 0);
  const taxedMinor = Math.max(0, subtotalMinor - discountMinor) + serviceMinor;
  const taxMinor = t.taxRate ? applyRate(taxedMinor, t.taxRate) : 0;
  const computedMinor = taxedMinor + taxMinor;
  const totalMinor = t.total != null ? toMinor(t.total) : computedMinor;
  return {
    cur,
    subtotal: fromMinor(subtotalMinor),
    discount: fromMinor(discountMinor),
    service: fromMinor(serviceMinor),
    tax: fromMinor(taxMinor),
    total: fromMinor(totalMinor),
  };
}

/**
 * The buyer rows of a tax document, in the browser invoice's labels. A full tax
 * invoice (`buyerSlots`) prints all three of Schedule 5's slots, blank when
 * unknown; anything else prints only what was given.
 * @param {import('../../domain.js').Fiscal} fiscal
 * @returns {[string, string][]}
 */
export function buyerRows(fiscal) {
  const rows = /** @type {[string, string][]} */ ([
    ['Buyer', fiscal.buyer?.name ?? ''],
    ['Buyer address', fiscal.buyer?.address ?? ''],
    ['Buyer PAN', fiscal.buyer?.pan ?? ''],
  ]);
  return fiscal.buyerSlots ? rows : rows.filter(([, value]) => value !== '');
}

/**
 * @param {import('../../domain.js').Ticket} t
 * @param {{shopName?:string, shopLines?:string[]}} [opts]  config branding — a
 *   FALLBACK only. A bill that carries its own `shopName`/`shopLines` (snackk's
 *   issuer identity, which travels with the bill) always wins, so a name
 *   configured on the box can never override the real restaurant on the receipt.
 */
export function billReceipt(t, opts = {}) {
  const { cur, subtotal, discount, service, tax, total } = computeTotals(t);
  const fiscal = t.fiscal;
  const b = new DocBuilder();

  const shopName = t.shopName ?? opts.shopName ?? 'RECEIPT';
  const shopLines = (t.shopLines && t.shopLines.length ? t.shopLines : opts.shopLines) ?? [];

  b.align('center').text(shopName, { bold: true, doubleH: true });
  for (const l of shopLines) b.text(l);

  // A reprint says it is a copy and which one — "Copy of Original (1)" — in the
  // exact words snackk decided, the same text its browser invoice prints. The
  // agent never numbers copies itself: the count lives with the document.
  const copyBanner = t.copyLabel;

  if (fiscal) {
    // A legal tax-invoice receipt: banner + the fiscal meta block, in the browser
    // invoice's order (title, then the copy label, then Invoice no. / dates /
    // Table / buyer) — snackk docs/INVOICE_FORMAT.md.
    if (fiscal.docTitle) b.text(fiscal.docTitle, { bold: true });
    if (copyBanner) b.text(copyBanner, { bold: true });
    b.align('left');
    if (fiscal.invoiceNo) b.row('Invoice no.', fiscal.invoiceNo);
    if (fiscal.dateBs) b.row('Date (BS)', fiscal.dateBs);
    if (fiscal.dateAd) b.row('Date (AD)', fiscal.dateAd);
    if (t.table) b.row('Table', t.table);
    for (const [label, value] of buyerRows(fiscal)) b.row(label, value);
  } else {
    if (copyBanner) b.text(copyBanner, { bold: true });
    // The plain settle slip: bill number, table, and the settle time.
    if (t.number != null) b.text(`Bill #${t.number}`);
    if (t.table) b.text(`Table ${t.table}`);
    if (t.placedAt) b.text(fmtTime(t.placedAt));
    b.align('left');
  }
  b.rule('=');

  const items = t.items.filter((it) => !it.voided);
  // Every line carries its printed rate → the tax invoice's `Item | Qty | Rate |
  // Amount` table (lines before VAT, summing to the Subtotal). Any line without
  // one → the legacy rows, byte-identical to before, so an older upstream (or a
  // hand-built ticket) never prints a half-filled table.
  const table = items.length > 0 && items.every((it) => it.rate != null);
  if (table) b.itemHead();
  for (const it of items) {
    // A trusted line amount (upstream owns the line math, incl. modifiers) prints
    // verbatim; otherwise format the SAME rounded minor-unit value that fed the
    // subtotal, so the column of line totals always sums to the printed subtotal.
    const lineTotal = it.amount != null ? money(it.amount, cur) : money(fromMinor(lineMinor(it)), cur);
    if (table) b.item(it.name, it.qty, money(it.rate, cur), lineTotal);
    else b.row(`${it.qty}x ${it.name}`, lineTotal);
    for (const m of it.modifiers ?? []) b.text(`   - ${m}`);
  }
  b.rule('-');

  b.row('Subtotal', money(subtotal, cur));
  const discountLabel = (discount && t.discountLabel) || 'Discount';
  if (fiscal) {
    // Fiscal parity with the browser invoice: the discount line even at zero (a
    // legal document shows it), service charge ABOVE the taxable base because
    // VAT is charged on it, then VAT — the split a tax invoice must show.
    b.row(discountLabel, money(discount, cur));
    if (service) b.row(t.serviceLabel ?? 'Service charge', money(service, cur));
    const taxable = fiscal.taxable ?? t.totals?.taxable ?? Math.max(0, subtotal - discount) + service;
    b.row('Taxable amount', money(taxable, cur));
    if (tax) b.row(t.taxLabel ?? 'VAT', money(tax, cur));
    b.rule('-');
    b.row('Total', money(total, cur), { bold: true });
    for (const p of fiscal.payments ?? []) b.row(`Paid - ${p.label}`, money(p.amount, cur));
  } else {
    // The same rows, order and wording as the browser receipt — zero-value rows
    // omitted (this slip is not a legal document that must show them).
    if (discount) b.row(discountLabel, money(discount, cur));
    if (service) b.row(t.serviceLabel ?? 'Service', money(service, cur));
    if (tax && t.totals?.taxable != null) b.row('Taxable amount', money(t.totals.taxable, cur));
    if (tax) b.row(t.taxLabel ?? `Tax`, money(tax, cur));
    b.rule('-');
    b.row('TOTAL', money(total, cur), { bold: true, doubleH: true });
    // How it was paid — one row per tender, same "Paid - X" wording as the
    // fiscal receipt. The legacy single-line `payment` only when no list came.
    if (t.payments && t.payments.length) {
      for (const p of t.payments) b.row(`Paid - ${p.label}`, money(p.amount, cur));
    } else if (t.payment) {
      b.row('Paid', t.payment);
    }
  }

  if (t.qr) b.feed(1).qr(t.qr);
  // "Menu prices include 13% VAT." — why the lines read below the menu.
  if (t.notes?.length) {
    b.feed(1).align('center');
    for (const n of t.notes) b.text(n);
  }
  if (fiscal) {
    b.feed(1).align('center').text(`Printed on ${fmtNow()}`);
    b.text(t.footer ?? 'Thank you!');
  } else if (t.footer) {
    b.feed(1).align('center').text(t.footer);
  }
  b.feed(1).cut();
  if (t.openDrawer) b.drawer();
  return b.build();
}
