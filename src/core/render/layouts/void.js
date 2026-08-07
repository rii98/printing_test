/**
 * VOID slip — printed to a station when a whole ticket is cancelled, so the line
 * knows to stop/discard. Deliberately loud and unmistakable.
 */
import { DocBuilder } from '../doc.js';

/** @param {import('../../domain.js').Ticket} t */
export function voidSlip(t) {
  const b = new DocBuilder();
  b.align('center');
  b.text('*** VOID ***', { bold: true, doubleH: true, doubleW: true });
  b.rule('=');
  if (t.number != null) b.text(`Ticket #${t.number}`, { bold: true, doubleH: true });
  if (t.table) b.text(`Table ${t.table}`, { bold: true });
  b.rule('-');
  b.align('left');
  for (const it of t.items) b.text(`${it.qty}x ${it.name}`);
  if (t.voidReason) { b.rule('-'); b.align('center').text(`Reason: ${t.voidReason}`); }
  b.feed(1).cut();
  return b.build();
}
