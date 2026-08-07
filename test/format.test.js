import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrap, leftRight, center, money, rule } from '../src/core/render/format.js';

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
