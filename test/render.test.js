import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTicket } from '../src/core/domain.js';
import { renderTicket } from '../src/core/render/index.js';
import { computeTotals } from '../src/core/render/layouts/bill.js';
import { toText } from '../src/core/render/preview.js';

const kitchen = normalizeTicket({
  id: 'o1', number: 12, station: 'kitchen', table: '5', server: 'Ram',
  items: [
    { name: 'Chicken Momo', qty: 2, modifiers: ['No garlic'], note: 'extra hot' },
    { name: 'Veg Chowmein', qty: 1 },
  ],
});

test('KOT shows qty + items, no prices', () => {
  const txt = toText(renderTicket(kitchen), { width: 48 });
  assert.match(txt, /KITCHEN ORDER/);
  assert.match(txt, /2x\s+Chicken Momo/i);   // preview upper-cases bold lines
  assert.match(txt, /- No garlic/);
  assert.match(txt, /\* extra hot/);
  assert.ok(!/\d+\.\d\d/.test(txt), 'KOT must not contain prices');
});

test('BOT uses the bar banner', () => {
  const bar = normalizeTicket({ id: 'b1', station: 'bar', items: [{ name: 'Mojito', qty: 2 }] });
  assert.match(toText(renderTicket(bar)), /BAR ORDER/);
});

test('bill computes subtotal, discount, tax, total', () => {
  const bill = normalizeTicket({
    id: 'p1', number: 12, station: 'cashier', currency: 'Rs',
    items: [{ name: 'Momo', qty: 2, price: 150 }, { name: 'Tea', qty: 1, price: 50 }],
    discount: 50, taxRate: 0.13, taxLabel: 'VAT 13%',
  });
  const { subtotal, discount, tax, total } = computeTotals(bill);
  assert.equal(subtotal, 350);
  assert.equal(discount, 50);
  assert.equal(Math.round(tax), 39);          // (350-50)*0.13 = 39
  assert.equal(Math.round(total), 339);
  const txt = toText(renderTicket(bill));
  assert.match(txt, /Subtotal/);
  assert.match(txt, /VAT 13%/);
  assert.match(txt, /TOTAL/);
});

test('explicit total overrides computed', () => {
  const bill = normalizeTicket({ id: 'p2', station: 'cashier', items: [{ name: 'x', qty: 1, price: 100 }], total: 999 });
  assert.equal(computeTotals(bill).total, 999);
});

test('trusted breakdown renders upstream totals verbatim, never recomputed from items', () => {
  // Item prices here would compute a WILDLY different bill (subtotal 100). The
  // trusted `totals` (as snackk would send after VAT-inclusive + a promo) must
  // win untouched — that is the guarantee the printed total matches the counter.
  const bill = normalizeTicket({
    id: 'bill:s1', station: 'cashier', currency: 'Rs',
    items: [{ name: 'Momo', qty: 2, amount: 265.49 }],
    totals: { subtotal: 265.49, discount: 15.49, service: 25, tax: 32.5, total: 307.5 },
    taxLabel: 'VAT 13%',
  });
  const c = computeTotals(bill);
  assert.deepEqual(
    { subtotal: c.subtotal, discount: c.discount, service: c.service, tax: c.tax, total: c.total },
    { subtotal: 265.49, discount: 15.49, service: 25, tax: 32.5, total: 307.5 },
  );
  const txt = toText(renderTicket(bill));
  assert.match(txt, /TOTAL\s+RS 307\.50/i); // doubleH row; preview upper-cases it
  assert.match(txt, /2x Momo\s+Rs 265\.49/); // the trusted per-line amount, not qty×price
  assert.match(txt, /VAT 13%\s+Rs 32\.50/);
});

test('a partial/garbage trusted totals block is rejected whole (never half-prints)', () => {
  assert.throws(
    () => normalizeTicket({ id: 'b', station: 'cashier', items: [{ name: 'x', qty: 1, price: 1 }], totals: { subtotal: 10 } }),
    /ticket\.totals\.discount must be a number/,
  );
});

test('H4: printed line items sum exactly to the printed subtotal', () => {
  // On the old float code these three 0.125 lines each printed 0.13 while the
  // subtotal summed the raw floats and printed 0.25 — a receipt that didn't add up.
  const bill = normalizeTicket({
    id: 'r1', station: 'cashier', currency: 'Rs',
    items: [{ name: 'Tea', qty: 1, price: 0.125 }, { name: 'Tea', qty: 1, price: 0.125 }, { name: 'Tea', qty: 1, price: 0.125 }],
  });
  const txt = toText(renderTicket(bill));
  const lineTotals = [...txt.matchAll(/Rs (\d+\.\d\d)/g)].map((m) => Number(m[1]));
  const subtotalLine = txt.split('\n').find((l) => /Subtotal/i.test(l));
  const subtotal = Number(subtotalLine.match(/(\d+\.\d\d)/)[1]);
  // First three matches are the item lines; they must sum to the subtotal.
  const sumOfItems = lineTotals.slice(0, 3).reduce((a, b) => a + b, 0);
  assert.equal(sumOfItems.toFixed(2), subtotal.toFixed(2), `items ${sumOfItems} != subtotal ${subtotal}`);
});

test('voided ticket renders a VOID slip regardless of station', () => {
  const v = normalizeTicket({ id: 'o1', revision: 2, station: 'kitchen', voided: true, voidReason: 'wrong table', items: [{ name: 'Momo', qty: 2 }] });
  const txt = toText(renderTicket(v));
  assert.match(txt, /VOID/);
  assert.match(txt, /wrong table/);
});

test('58mm (width 32) never overflows the column', () => {
  const txt = toText(renderTicket(kitchen), { width: 32 });
  for (const line of txt.split('\n')) assert.ok(line.length <= 32, `overflow: "${line}"`);
});
