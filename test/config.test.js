import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

// Run loadConfig() with a temporary set of env overrides, then restore whatever
// was there before — tests must never leak process.env state into each other.
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); }
  finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('valid numeric env overrides are applied', () => {
  withEnv({ PRINT_HTTP_PORT: '8080', PRINT_SHUTDOWN_GRACE_MS: '2500' }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.http.port, 8080);
    assert.equal(cfg.shutdown.graceMs, 2500);
  });
});

test('a non-numeric PRINT_HTTP_PORT is ignored, keeping the default (never NaN)', () => {
  withEnv({ PRINT_HTTP_PORT: 'abc' }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.http.port, 4000, 'falls back to the default port');
    assert.ok(!Number.isNaN(cfg.http.port), 'never binds a random port from NaN');
  });
});

test('an out-of-range / negative / fractional value is rejected', () => {
  withEnv({ PRINT_HTTP_PORT: '70000', PRINT_SHUTDOWN_GRACE_MS: '-5' }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.http.port, 4000, 'port above 65535 is rejected');
    assert.equal(cfg.shutdown.graceMs, 10_000, 'negative grace is rejected');
  });
  withEnv({ PRINT_HTTP_PORT: '80.5' }, () => {
    assert.equal(loadConfig().http.port, 4000, 'fractional port is rejected');
  });
});

test('an empty or whitespace override keeps the default', () => {
  withEnv({ PRINT_HTTP_PORT: '   ' }, () => {
    assert.equal(loadConfig().http.port, 4000);
  });
});

test('grace of 0 (drain-then-exit-immediately) is a valid choice', () => {
  withEnv({ PRINT_SHUTDOWN_GRACE_MS: '0' }, () => {
    assert.equal(loadConfig().shutdown.graceMs, 0);
  });
});
