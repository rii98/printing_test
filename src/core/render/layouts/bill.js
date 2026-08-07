/**
 * Customer bill / receipt (cashier). Prices, subtotal, discount, service charge,
 * tax, grand total, payment method, QR, footer. Totals are computed from the
 * items unless the caller supplies an explicit `total` (then it's trusted).
 */
import { DocBuilder } from '../doc.js';
import { money } from '../format.js';

const fmtTime = (v) => { try { return v ? new Date(v).toLocaleString() : ''; } catch { return ''; } };

/** Compute the money breakdown. Pure — unit-tested independently. */
export function computeTotals(t) {
  const cur = t.currency ?? '';
  const subtotal = t.items.filter((i) => !i.voided)
    .reduce((s, i) => s + (i.price ?? 0) * i.qty, 0);
  const discount = t.discount ?? 0;
  const service = t.serviceCharge ?? 0;
  const taxed = Math.max(0, subtotal - discount) + service;
  const tax = t.taxRate ? taxed * t.taxRate : 0;
  const computed = taxed + tax;
  const total = t.total != null ? t.total : computed;
  return { cur, subtotal, discount, service, tax, total };
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
    const lineTotal = money((it.price ?? 0) * it.qty, cur);
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
