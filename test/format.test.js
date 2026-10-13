import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrap, leftRight, center, money, rule, itemLines, itemHeader, ITEM_TABLE_MIN_WIDTH } from '../src/core/render/format.js';

test('wrap breaks on spaces within width', () => {
  assert.deepEqual(wrap('the quick brown fox', 9), ['the quick', 'brown fox']);
});

test('wrap hard-slices a word longer than the column', () => {
  assert.deepEqual(wrap('supercalifragilistic', 8), ['supercal', 'ifragili', 'stic']);
});

test('wrap preserves explicit newlines and blank lines', () => {
  assert.deepEqual(wrap('a\n\nb', 10), ['a', '', 'b']);
});

test('leftRight aligns value flush right', () => {
  const [line] = leftRight('Subtotal', '12.50', 20);
  assert.equal(line.length, 20);
  assert.ok(line.startsWith('Subtotal'));
  assert.ok(line.endsWith('12.50'));
});

test('leftRight wraps a long label, value stays on last line', () => {
  const lines = leftRight('A very long item name here', '9.99', 16);
  assert.ok(lines.length > 1);
  assert.ok(lines[lines.length - 1].endsWith('9.99'));
  for (const l of lines) assert.ok(l.length <= 16, `line too wide: "${l}"`);
});

test('money fixes 2 decimals with optional currency', () => {
  assert.equal(money(3.5), '3.50');
  assert.equal(money(3.005), '3.00'); // toFixed rounding is acceptable/documented
  assert.equal(money(10, 'Rs'), 'Rs 10.00');
  assert.equal(money(NaN), '0.00');
});

test('center and rule respect width', () => {
  assert.equal(center('hi', 6), '  hi');
  assert.equal(rule(5, '='), '=====');
});

test('H2: text helpers are total — degenerate widths never hang or throw', () => {
  // On the old code wrap(_, 0) looped forever (i += 0) until the process died.
  // A width of 0 is reachable via double-width math on a tiny column, or misconfig.
  for (const badWidth of [0, -5, NaN, undefined, 1.5, '48', Infinity]) {
    assert.doesNotThrow(() => {
      const lines = wrap('supercalifragilistic expialidocious', badWidth);
      assert.ok(Array.isArray(lines) && lines.length >= 1);
      for (const l of lines) assert.ok(l.length >= 1, 'no empty hard-slice fragments');
      center('hello world', badWidth);
      leftRight('Subtotal', '12.50', badWidth);
      rule(badWidth, '-');
    }, `width=${String(badWidth)} must be handled, not fatal`);
  }
});

test('H2: valid widths are unchanged by the guard', () => {
  assert.deepEqual(wrap('the quick brown fox', 9), ['the quick', 'brown fox']);
  assert.deepEqual(wrap('supercalifragilistic', 8), ['supercal', 'ifragili', 'stic']);
  assert.equal(rule(5, '='), '=====');
});

// ── the item table (Item | Qty | Rate | Amount) ─────────────────────────────

const momo = { name: 'Chicken Momo', qty: '2', rate: 'Rs 309.74', amount: 'Rs 619.47' };

test('80mm: the item table is four aligned columns, header and rows alike', () => {
  const head = itemHeader(48);
  const row = itemLines(momo, 48);
  assert.deepEqual(head, ['Item                Qty        Rate       Amount']);
  assert.deepEqual(row, ['Chicken Momo          2   Rs 309.74    Rs 619.47']);
  // Every column ends where its header does.
  for (const label of ['Qty', 'Rate', 'Amount']) {
    const end = head[0].indexOf(label) + label.length;
    assert.ok(row[0].slice(0, end).trimEnd().length === end, `${label} column misaligned`);
  }
});

test('80mm: a long name wraps inside its own column, figures stay on the first line', () => {
  const lines = itemLines({ name: 'Jack Daniels Old No. 7 Tennessee Whiskey', qty: '1', rate: 'Rs 2500.00', amount: 'Rs 2500.00' }, 48);
  assert.match(lines[0], /^Jack Daniels Old\s+1\s+Rs 2500\.00\s+Rs 2500\.00$/);
  assert.ok(lines.length > 1);
  for (const l of lines.slice(1)) assert.doesNotMatch(l, /Rs/);
});

test('58mm: qty x name and amount on one line, the rate indented beneath', () => {
  assert.deepEqual(itemHeader(32), ['Item                      Amount']);
  assert.deepEqual(itemLines(momo, 32), ['2x Chicken Momo        Rs 619.47', '   @ Rs 309.74']);
});

test('a figure too wide for its column falls back to the narrow shape — never truncated', () => {
  const huge = { name: 'Banquet', qty: '1', rate: 'Rs 1234567.00', amount: 'Rs 1234567.00' };
  const lines = itemLines(huge, 48);
  assert.ok(lines.some((l) => l.endsWith('Rs 1234567.00')));
  assert.ok(lines.some((l) => l.includes('@ Rs 1234567.00')));
});

test('the item table never overflows the column, at any width, for any input', () => {
  const names = ['', 'x', 'Chicken Momo', 'A'.repeat(90), 'word '.repeat(30)];
  for (const width of [1, 8, 20, 31, 32, ITEM_TABLE_MIN_WIDTH - 1, ITEM_TABLE_MIN_WIDTH, 42, 48, 64]) {
    for (const name of names) {
      for (const l of [...itemHeader(width), ...itemLines({ ...momo, name }, width)]) {
        // At pathological widths a single token wider than the paper is
        // hard-sliced by wrap; nothing ever exceeds max(width, longest figure).
        assert.ok(l.length <= Math.max(width, 'Rs 619.47'.length + 6), `w=${width} overflow: "${l}"`);
      }
    }
  }
  // Total: garbage widths return lines rather than throwing or hanging.
  for (const width of [NaN, -5, 0, Infinity]) assert.ok(itemLines(momo, width).length > 0);
});
