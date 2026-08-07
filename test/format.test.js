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
