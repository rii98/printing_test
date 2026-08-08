import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser } from '../src/inbound/snackk/sse-parse.js';

test('parses a complete id/event/data frame', () => {
  const p = createSseParser();
  const out = p.push('id: 5\nevent: ticket.new\ndata: {"a":1}\n\n');
  assert.deepEqual(out, [{ id: '5', event: 'ticket.new', data: '{"a":1}' }]);
});

test('ignores the heartbeat comment and the retry advisory', () => {
  const p = createSseParser();
  assert.deepEqual(p.push(': ping\n\n'), []);
  assert.deepEqual(p.push('retry: 3000\n\n'), []);
});

test('reassembles a frame split across chunks', () => {
  const p = createSseParser();
  assert.deepEqual(p.push('event: ticket.up'), []);
  assert.deepEqual(p.push('dated\ndata: {"x"'), []);
  assert.deepEqual(p.push(':2}\n\n'), [{ id: undefined, event: 'ticket.updated', data: '{"x":2}' }]);
});

test('joins multiple data lines with a newline (SSE spec)', () => {
  const p = createSseParser();
  const [e] = p.push('data: line1\ndata: line2\n\n');
  assert.equal(e.data, 'line1\nline2');
});

test('strips exactly one leading space after the colon', () => {
  const p = createSseParser();
  const [e] = p.push('data:  two-spaces\n\n'); // one stripped, one kept
  assert.equal(e.data, ' two-spaces');
});

test('handles CRLF line endings', () => {
  const p = createSseParser();
  const out = p.push('id: 9\r\nevent: ticket.new\r\ndata: {}\r\n\r\n');
  assert.deepEqual(out, [{ id: '9', event: 'ticket.new', data: '{}' }]);
});

test('yields several frames from one chunk', () => {
  const p = createSseParser();
  const out = p.push('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n');
  assert.equal(out.length, 2);
  assert.equal(out[0].event, 'a');
  assert.equal(out[1].event, 'b');
});
