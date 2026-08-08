/**
 * snackk → neutral Ticket translation. The ONE place this agent knows snackk's
 * wire shapes; everything downstream depends only on our own `Ticket`
 * (src/core/domain.js), so a change to snackk's DTO stops here.
 *
 * Pure and side-effect free — the SSE subscriber (src/inbound/snackk/subscribe.js)
 * decides WHICH events to forward; these functions only translate and decide the
 * print MOMENT. Bill mapping lives in Slice B (needs a trusted-breakdown layout).
 *
 * Shapes mirrored from snackk:
 *   OrderTicketDto  server/validators/orders.ts
 *   ORDER_STATES / stationBoardStates()  server/domain/orderState.ts
 */

/**
 * The state at which a ticket first appears on its station board — the moment to
 * print a KOT/BOT. A ticket enters the board exactly once in its life:
 *   • direct         — fired straight to the station as `received`.
 *   • waiter_confirm — held in the waiter queue as `received`, reaching the
 *                      station only when a waiter advances it to `confirmed`.
 * So printing on this single state (backed by the id@revision idempotency store)
 * is exactly-once, and never fires early for a still-unconfirmed order. Later
 * states (preparing/ready) are transitions a human made AFTER the slip printed;
 * a recall never returns a ticket to the fire state, so it can't re-fire.
 * @param {'direct'|'waiter_confirm'} routingMode
 * @returns {'received'|'confirmed'}
 */
export function fireState(routingMode) {
  return routingMode === 'waiter_confirm' ? 'confirmed' : 'received';
}

/**
 * Should this ticket event print a KOT/BOT now? True only on the fire state, so
 * a ticket the agent first observes mid-life (it connected late, or a bump
 * arrived) is NOT printed — that slip already came out, or a human owns it.
 * @param {{state:string}} dto
 * @param {'direct'|'waiter_confirm'} routingMode
 */
export function isPrintFire(dto, routingMode) {
  return dto.state === fireState(routingMode);
}

/** A whole-ticket cancellation — print a VOID slip so the station pulls the dish. */
export function isVoid(dto) {
  return dto.state === 'void';
}

/**
 * Inline dish + portion, exactly as snackk's KDS reads it: `Chicken Chilli (Full)`.
 * The portion is part of the dish name on a ticket, never a modifier line
 * (snackk variantLabel, docs §3.2).
 */
function lineName(line) {
  return line.variantName ? `${line.itemName} (${line.variantName})` : line.itemName;
}

/** OrderTicketDto lines → neutral TicketItems. Modifiers become plain names
 *  (a KOT/BOT shows WHAT to make, never the price of a modifier). */
function mapItems(lines) {
  return (Array.isArray(lines) ? lines : []).map((l) => ({
    name: lineName(l),
    qty: l.quantity,
    modifiers: Array.isArray(l.modifiers) && l.modifiers.length
      ? l.modifiers.map((m) => m.name)
      : undefined,
    note: l.note ?? undefined,
  }));
}

/**
 * snackk OrderTicketDto → our neutral Ticket (KOT/BOT or a VOID slip).
 *
 * `revision` is always 0: snackk never adds lines to an existing ticket — a new
 * round is a new order with a new id — so a ticket prints once and any later
 * state change is dropped as a duplicate on the id@0 key. A void is emitted with
 * `voided:true`, whose idempotency key is DISTINCT (`id@0:void`), so the VOID
 * slip prints even though the original KOT already did.
 *
 * `station` passes straight through (`kitchen`→KOT, `bar`→BOT); the agent's
 * printer registry maps each station to a device.
 * @param {import('./types').OrderTicketDto} dto
 * @returns {import('../../core/domain.js').Ticket}
 */
export function orderTicketToTicket(dto) {
  const voided = dto.state === 'void';
  const ticket = {
    id: dto.orderId,
    revision: 0,
    number: dto.ticketNumber,
    station: dto.station,
    table: dto.tableLabel,
    placedAt: dto.placedAt,
    items: mapItems(dto.lines),
    voided,
  };
  if (voided && dto.voidReason) ticket.voidReason = dto.voidReason;
  return ticket;
}

/**
 * Decide what to do with one order event, given the live config and the set of
 * orderIds this agent has already KOT/BOT-printed this run. Pure — the subscriber
 * calls it and acts on the result, so the whole policy is unit-testable without a
 * socket:
 *   • KDS-only delivery      → skip (the boards handle it).
 *   • a void of a ticket we   → print a VOID slip (pull the dish).
 *     already printed
 *   • a void we never printed → skip (no slip ever came out; a void is noise).
 *   • the fire state          → print the KOT/BOT.
 *   • anything else           → skip (a later bump, or a still-unconfirmed order).
 *
 * @param {{orderId:string, state:string}} dto
 * @param {{stationDelivery:'kds'|'print'|'both', orderRoutingMode:'direct'|'waiter_confirm'}} config
 * @param {Set<string>} printed  orderIds already printed (mutated by the caller)
 * @returns {{action:'print'|'skip', reason:string, ticket?:import('../../core/domain.js').Ticket, firstPrint?:boolean}}
 */
export function printAction(dto, config, printed) {
  const printing = config.stationDelivery === 'print' || config.stationDelivery === 'both';
  if (!printing) return { action: 'skip', reason: 'kds-only' };

  if (isVoid(dto)) {
    if (!printed.has(dto.orderId)) return { action: 'skip', reason: 'void-never-printed' };
    return { action: 'print', reason: 'void', ticket: orderTicketToTicket(dto) };
  }

  if (isPrintFire(dto, config.orderRoutingMode)) {
    // firstPrint tells the caller to remember this orderId, so a later void of
    // it prints a slip while a void of a never-fired ticket stays silent.
    return { action: 'print', reason: 'fire', ticket: orderTicketToTicket(dto), firstPrint: true };
  }

  return { action: 'skip', reason: 'not-fire' };
}

/**
 * Decide what to do with one ticket from a station-board SEED snapshot (fetched
 * on (re)connect, see subscribe.js). Unlike the live stream — which fires only on
 * the single fire-state event — every ticket on a board is at or PAST its fire
 * state by construction (stationBoardStates), so any board ticket the agent
 * hasn't printed is a KOT it missed while disconnected: print it. The durable
 * id@0 idempotency store makes a re-seed of an already-printed ticket a no-op, so
 * seeding on every reconnect stays exactly-once. Voids never appear on a board,
 * so there is no void case here.
 *
 * @param {{orderId:string, state:string}} dto
 * @param {{stationDelivery:'kds'|'print'|'both'}} config
 * @param {{has:(k:string)=>boolean, add:(k:string)=>void}} printed
 * @returns {{action:'print'|'skip', reason:string, ticket?:import('../../core/domain.js').Ticket, firstPrint?:boolean}}
 */
export function printActionSeed(dto, config, printed) {
  const printing = config.stationDelivery === 'print' || config.stationDelivery === 'both';
  if (!printing) return { action: 'skip', reason: 'kds-only' };
  return { action: 'print', reason: 'seed', ticket: orderTicketToTicket(dto), firstPrint: true };
}
