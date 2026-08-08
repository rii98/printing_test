/**
 * Customer bill / receipt (cashier). Prices, subtotal, discount, service charge,
 * tax, grand total, payment method, QR, footer. Totals are computed from the
 * items unless the caller supplies an explicit `total` (then it's trusted).
 */
import { DocBuilder } from '../doc.js';
import { money } from '../format.js';
import { toMinor, fromMinor, applyRate } from '../../money.js';

const fmtTime = (v) => { try { return v ? new Date(v).toLocaleString() : ''; } catch { return ''; } };

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
 * @param {import('../../domain.js').Ticket} t
 * @param {{shopName?:string, shopLines?:string[]}} [opts]
 */
export function billReceipt(t, { shopName = 'RECEIPT', shopLines = [] } = {}) {
  const { cur, subtotal, discount, service, tax, total } = computeTotals(t);
  const b = new DocBuilder();

  b.align('center').text(shopName, { bold: true, doubleH: true });
  for (const l of shopLines) b.text(l);
  if (t.number != null) b.text(`Bill #${t.number}`);
  if (t.table) b.text(`Table ${t.table}`);
  if (t.placedAt) b.text(fmtTime(t.placedAt));
  b.rule('=');

  b.align('left');
  for (const it of t.items) {
    if (it.voided) continue;
    // A trusted line amount (upstream owns the line math, incl. modifiers) prints
    // verbatim; otherwise format the SAME rounded minor-unit value that fed the
    // subtotal, so the column of line totals always sums to the printed subtotal.
    const lineTotal = it.amount != null ? money(it.amount, cur) : money(fromMinor(lineMinor(it)), cur);
    b.row(`${it.qty}x ${it.name}`, lineTotal);
    for (const m of it.modifiers ?? []) b.text(`   - ${m}`);
  }
  b.rule('-');

  b.row('Subtotal', money(subtotal, cur));
  if (discount) b.row('Discount', `- ${money(discount, cur)}`);
  if (service) b.row('Service', money(service, cur));
  if (tax) b.row(t.taxLabel ?? `Tax`, money(tax, cur));
  b.rule('-');
  b.row('TOTAL', money(total, cur), { bold: true, doubleH: true });
  if (t.payment) b.row('Paid', t.payment);

  if (t.qr) b.feed(1).qr(t.qr);
  if (t.footer) b.feed(1).align('center').text(t.footer);
  b.feed(1).cut();
  if (t.openDrawer) b.drawer();
  return b.build();
}
