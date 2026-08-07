import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../src/core/render/escpos.js';
import { DocBuilder } from '../src/core/render/doc.js';

test('encode starts with ESC @ init', () => {
  const buf = encode(new DocBuilder().text('hi').build());
  assert.equal(buf[0], 0x1b);
  assert.equal(buf[1], 0x40);
});

test('cut emits GS V 66 (feed-to-blade + cut, and can be suppressed)', () => {
  const withCut = encode(new DocBuilder().cut().build());
  assert.ok(withCut.includes(Buffer.from([0x1d, 0x56, 0x42])), 'should contain GS V 66 (function B)');
  const noCut = encode(new DocBuilder().cut().build(), { cut: false });
  assert.ok(!noCut.includes(Buffer.from([0x1d, 0x56, 0x42])), 'cut:false suppresses the cutter');
});

test('qr emits a GS ( k store+print sequence containing the payload', () => {
  const buf = encode(new DocBuilder().qr('https://x.io/1').build());
  assert.ok(buf.includes(Buffer.from('https://x.io/1', 'utf8')), 'payload present');
  assert.ok(buf.includes(Buffer.from([0x1d, 0x28, 0x6b])), 'GS ( k present');
});

test('bold wraps text in ESC E 1 / ESC E 0', () => {
  const buf = encode(new DocBuilder().text('X', { bold: true }).build());
  assert.ok(buf.includes(Buffer.from([0x1b, 0x45, 0x01])), 'bold on');
  assert.ok(buf.includes(Buffer.from([0x1b, 0x45, 0x00])), 'bold off');
});

test('drawer emits the kick sequence', () => {
  const buf = encode(new DocBuilder().drawer().build());
  assert.ok(buf.includes(Buffer.from([0x1b, 0x70, 0x00])), 'ESC p 0 present');
});
