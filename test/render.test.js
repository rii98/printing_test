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

test('a fiscal bill prints the full tax-invoice layout, matching the browser', () => {
  // The receipt the on-prem printer must produce, byte-parity with the counter's
  // browser ABBREVIATED TAX INVOICE: issuer + PAN, banner, fiscal meta, the
  // taxable/VAT split, and the tender breakdown.
  const bill = normalizeTicket({
    id: 'bill:s2', station: 'cashier', currency: 'Rs', table: 'Table Y',
    shopName: 'Alchemist', shopLines: ['PAN 123456789'],
    items: [
      { name: 'Jack Denials (Half)', qty: 1, amount: 2500, modifiers: ['water'] },
      { name: 'Black Label 1 Quater', qty: 1, amount: 2310 },
    ],
    totals: { subtotal: 4256.64, discount: 150, service: 0, tax: 533.86, total: 4640.5 },
    taxLabel: 'VAT (13%)',
    fiscal: {
      docTitle: 'ABBREVIATED TAX INVOICE', invoiceNo: '2083/84-000042',
      dateBs: '2083-04-24', dateAd: '2026-08-09', taxable: 4106.64,
      payments: [{ label: 'Cash', amount: 2040.5 }, { label: 'Khalti', amount: 2600 }],
    },
  });
  const txt = toText(renderTicket(bill));
  assert.match(txt, /Alchemist/i); // bold header; the text preview upper-cases it
  assert.match(txt, /PAN 123456789/);
  assert.match(txt, /ABBREVIATED TAX INVOICE/);
  assert.match(txt, /Invoice no\.\s+2083\/84-000042/);
  assert.match(txt, /Date \(BS\)\s+2083-04-24/);
  assert.match(txt, /Date \(AD\)\s+2026-08-09/);
  assert.match(txt, /Taxable amount\s+Rs 4106\.64/);
  assert.match(txt, /VAT \(13%\)\s+Rs 533\.86/);
  assert.match(txt, /Total\s+RS 4640\.50/i);
  assert.match(txt, /Paid - Cash\s+Rs 2040\.50/);
  assert.match(txt, /Paid - Khalti\s+Rs 2600\.00/);
  assert.match(txt, /Printed on/);
  assert.match(txt, /Thank you!/);
  // It must NOT fall back to the plain slip's markers.
  assert.doesNotMatch(txt, /Bill #/);
  assert.doesNotMatch(txt, /NAMASTE MINI MARKET/);
});

test('a reprint prints a COPY OF ORIGINAL banner; the original prints none', () => {
  const base = {
    id: 'bill:s3', station: 'cashier', currency: 'Rs', number: 42, table: 'T7',
    items: [{ name: 'Momo', qty: 1, amount: 100 }],
    totals: { subtotal: 100, discount: 0, service: 0, tax: 0, total: 100 },
  };
  // Original (copy 0) — no banner.
  assert.doesNotMatch(toText(renderTicket(normalizeTicket(base))), /COPY OF ORIGINAL/);
  // First reprint — the banner, unnumbered (it's simply "a copy").
  const c1 = toText(renderTicket(normalizeTicket({ ...base, copyOf: 1 })));
  assert.match(c1, /COPY OF ORIGINAL/);
  assert.doesNotMatch(c1, /COPY OF ORIGINAL - /);
  // Second copy on — numbered.
  assert.match(toText(renderTicket(normalizeTicket({ ...base, copyOf: 3 }))), /COPY OF ORIGINAL - 3/);
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

test('the plain slip keeps the legacy single-line payment when no tender list is given', () => {
  const base = {
    id: 'bill:s4', station: 'cashier', currency: 'Rs', number: 43, table: 'T2',
    items: [{ name: 'Momo', qty: 1, amount: 100 }],
    totals: { subtotal: 100, discount: 0, service: 0, tax: 0, total: 100 },
  };
  assert.match(toText(renderTicket(normalizeTicket({ ...base, payment: 'Cash' }))), /Paid\s+Cash/);
  // A tender list wins over the legacy line — never both.
  const both = toText(renderTicket(normalizeTicket({
    ...base, payment: 'Cash', payments: [{ label: 'Khalti', amount: 100 }],
  })));
  assert.match(both, /Paid - Khalti\s+Rs 100\.00/);
  assert.doesNotMatch(both, /Paid\s+Cash/);
});

// ── tax-invoice format (snackk docs/INVOICE_FORMAT.md) ──────────────────────

const fiscalBase = {
  id: 'bill:f1', station: 'cashier', currency: 'Rs', table: 'T4',
  items: [{ name: 'Momo', qty: 2, rate: 300, amount: 600 }],
  totals: { subtotal: 600, discount: 0, service: 60, tax: 85.8, total: 745.8, taxable: 660 },
  taxLabel: 'VAT (13%)', serviceLabel: 'Service charge (10%)',
  fiscal: { docTitle: 'TAX INVOICE', invoiceNo: '2083/84-000001', taxable: 660 },
};
const order = (txt, labels) => labels.map((l) => txt.search(new RegExp(l, 'i')));

test('a tax invoice prints service charge ABOVE the taxable amount it is part of', () => {
  const txt = toText(renderTicket(normalizeTicket(fiscalBase)));
  const [sc, taxable, vat] = order(txt, ['Service charge \\(10%\\)', 'Taxable amount', 'VAT \\(13%\\)']);
  assert.ok(sc >= 0 && sc < taxable && taxable < vat, txt);
  assert.match(txt, /Taxable amount\s+Rs 660\.00/);
});

test('a tax invoice shows its discount line even at zero', () => {
  assert.match(toText(renderTicket(normalizeTicket(fiscalBase))), /Discount\s+Rs 0\.00/);
});

test('a copy banner follows the document title, as on the browser invoice', () => {
  const txt = toText(renderTicket(normalizeTicket({ ...fiscalBase, copyOf: 2 })));
  assert.ok(txt.indexOf('TAX INVOICE') < txt.indexOf('COPY OF ORIGINAL - 2'));
});

test('buyer rows: full tax invoice prints all three slots; abbreviated only what was given', () => {
  const full = toText(renderTicket(normalizeTicket({
    ...fiscalBase, fiscal: { ...fiscalBase.fiscal, buyerSlots: true, buyer: { name: 'Ramesh Thapa' } },
  })));
  assert.match(full, /Buyer\s+Ramesh Thapa/);
  assert.match(full, /^Buyer address\s*$/m);
  assert.match(full, /^Buyer PAN\s*$/m);
  const abbreviated = toText(renderTicket(normalizeTicket({
    ...fiscalBase, fiscal: { ...fiscalBase.fiscal, docTitle: 'ABBREVIATED TAX INVOICE', buyer: { name: 'Sita' } },
  })));
  assert.match(abbreviated, /Buyer\s+Sita/);
  assert.doesNotMatch(abbreviated, /Buyer (address|PAN)/);
});

test('the plain slip mirrors the browser receipt: taxable row, plain discount, the note', () => {
  const txt = toText(renderTicket(normalizeTicket({
    id: 'bill:p9', station: 'cashier', currency: 'Rs', number: 57, table: 'T4',
    items: [{ name: 'Momo', qty: 2, rate: 300, amount: 600 }],
    totals: { subtotal: 600, discount: 60, service: 0, tax: 70.2, total: 610.2, taxable: 540 },
    taxLabel: 'VAT (13%)', discountLabel: 'Friday Spin (10%)', notes: ['Menu prices include 13% VAT.'],
  })));
  assert.match(txt, /Item\s+Qty\s+Rate\s+Amount/);
  assert.match(txt, /Momo\s+2\s+Rs 300\.00\s+Rs 600\.00/);
  assert.match(txt, /Friday Spin \(10%\)\s+Rs 60\.00/);
  assert.match(txt, /Taxable amount\s+Rs 540\.00/);
  assert.match(txt, /Menu prices include 13% VAT\./);
});

test('a ticket with any line lacking a rate keeps the legacy item rows (no half table)', () => {
  const txt = toText(renderTicket(normalizeTicket({
    id: 'bill:l1', station: 'cashier', currency: 'Rs',
    items: [{ name: 'Momo', qty: 2, rate: 300, amount: 600 }, { name: 'Tea', qty: 1, amount: 50 }],
    totals: { subtotal: 650, discount: 0, service: 0, tax: 0, total: 650 },
  })));
  assert.doesNotMatch(txt, /Item\s+Qty/);
  assert.match(txt, /2x Momo\s+Rs 600\.00/);
});

test('a negative or garbage rate is rejected like any other money field', () => {
  assert.throws(() => normalizeTicket({ id: 'x', station: 'cashier', items: [{ name: 'a', rate: -1 }] }), /items\[0\]\.rate/);
  assert.throws(() => normalizeTicket({
    id: 'x', station: 'cashier', items: [{ name: 'a', amount: 1 }],
    totals: { subtotal: 1, discount: 0, service: 0, tax: 0, total: 1, taxable: 'x' },
  }), /totals\.taxable/);
});
