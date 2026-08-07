import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMinor, fromMinor, applyRate } from '../src/core/money.js';

test('toMinor rounds half away from zero, defeating binary float error', () => {
  assert.equal(toMinor(3.5), 350);
  assert.equal(toMinor(0.1), 10);
  assert.equal(toMinor(0.125), 13);     // 12.5 -> 13
  assert.equal(toMinor(1.005), 101);    // classic: 1.005*100 = 100.4999999 -> 101
  assert.equal(toMinor(2.675), 268);    // 267.4999999 -> 268
  assert.equal(toMinor(10), 1000);
  assert.equal(toMinor(0), 0);
});

test('toMinor is total: non-finite / garbage -> 0', () => {
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, 'abc']) assert.equal(toMinor(bad), 0);
});

test('fromMinor is the exact inverse for integer minor units', () => {
  assert.equal(fromMinor(350), 3.5);
  assert.equal(fromMinor(101), 1.01);
  assert.equal(fromMinor(0), 0);
});

test('applyRate keeps tax in integer minor units', () => {
  assert.equal(applyRate(30000, 0.13), 3900);
  assert.equal(applyRate(100, 0), 0);
  assert.equal(applyRate(100, NaN), 0);
});

test('summing rounded lines equals the rounded subtotal (the invariant)', () => {
  const prices = [0.125, 0.125, 0.10, 0.335];
  const lineMinors = prices.map(toMinor);
  const subtotalMinor = lineMinors.reduce((a, b) => a + b, 0);
  // sum of displayed lines (each fromMinor) must equal displayed subtotal
  const sumOfDisplayed = lineMinors.map(fromMinor).reduce((a, b) => a + Math.round(b * 100), 0);
  assert.equal(sumOfDisplayed, subtotalMinor);
});
