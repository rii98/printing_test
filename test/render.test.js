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
