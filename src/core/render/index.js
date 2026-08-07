/**
 * renderTicket — Ticket -> Doc, choosing the layout. A voided ticket always
 * renders a VOID slip regardless of station. Otherwise the station's default doc
 * kind (kot/bot/bill) picks the layout.
 */
import { STATION_DOC } from '../domain.js';
import { kitchenTicket } from './layouts/kitchen.js';
import { billReceipt } from './layouts/bill.js';
import { voidSlip } from './layouts/void.js';

/**
 * @param {import('../domain.js').Ticket} ticket
 * @param {{docKind?:import('../domain.js').DocKind, branding?:{shopName?:string,shopLines?:string[]}}} [opts]
 * @returns {import('./doc.js').Doc}
 */
export function renderTicket(ticket, opts = {}) {
  if (ticket.voided) return voidSlip(ticket);
  const kind = opts.docKind ?? STATION_DOC[ticket.station] ?? 'kot';
  switch (kind) {
    case 'bill': return billReceipt(ticket, opts.branding);
    case 'bot': return kitchenTicket(ticket, { banner: 'BAR ORDER' });
    case 'kot':
    default: return kitchenTicket(ticket, { banner: 'KITCHEN ORDER' });
  }
}
