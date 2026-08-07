/**
 * KOT / BOT — the kitchen & bar ticket. No prices (the line cook doesn't care),
 * big item names, modifiers indented, table/server/time up top. KOT and BOT are
 * the same layout with a different banner, so they share this builder.
 */
import { DocBuilder } from '../doc.js';

const fmtTime = (v) => {
  try { return v ? new Date(v).toLocaleString() : new Date(0).toLocaleString(); }
  catch { return String(v ?? ''); }
};

/**
 * @param {import('../../domain.js').Ticket} t
 * @param {{banner?:string}} [opts]
 */
export function kitchenTicket(t, { banner = 'KITCHEN ORDER' } = {}) {
  const b = new DocBuilder();
  b.align('center').text(banner, { bold: true, doubleH: true });
  if (t.orderType) b.text(t.orderType.toUpperCase(), { bold: true });
  b.rule('=');

  b.align('left');
  if (t.number != null) b.row('Ticket', `#${t.number}`, { bold: true });
  if (t.table) b.row('Table', t.table, { bold: true });
  if (t.server) b.row('Server', t.server);
  if (t.placedAt) b.row('Time', fmtTime(t.placedAt));
  b.rule('-');

  for (const it of t.items) {
    const qty = `${it.qty}x`;
    if (it.voided) {
      b.row(`  ${it.name}`, 'VOID', { bold: true });
      continue;
    }
    // Big, scannable: "2x  Chicken Momo"
    b.text(`${qty}  ${it.name}`, { bold: true, doubleH: true });
    for (const m of it.modifiers ?? []) b.text(`     - ${m}`);
    if (it.note) b.text(`     * ${it.note}`);
  }
  b.rule('-');
  b.feed(1).cut();
  return b.build();
}
