// 🧪 Cloudflare adapter tests (cloudflare/worker.js).
//
// Runs in its own process (node --test). Two things make this file special:
//   1. cloudflare/worker.js imports the Workers-only built-in
//      'cloudflare:sockets', stubbed here via a registered ESM loader.
//   2. The adapter exports a { fetch, scheduled } object (Workers module
//      syntax) instead of a callable handler, and injects connect + no
//      pre-response deadline + proxy pool enabled by default.
//
// Tests pass env = { PROXY_KV: {...} } because that is how the worker runs in
// production (wrangler.jsonc binds a KV namespace) and the router's platform
// detection keys off it — mirroring real requests.

// Register the loader BEFORE importing the adapter.
import { register } from 'node:module';
register(
  new URL('./helpers/cloudflare-sockets-loader.mjs', import.meta.url),
  import.meta.url,
);

import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerAdapterSuite } from './helpers/adapter-suite.js';
import { setupTestEnv, req, jsonOf } from './helpers/env.js';

const restoreEnv = setupTestEnv();

const worker = await import('../../cloudflare/worker.js');

// Minimal stand-in for the wrangler.jsonc KV binding on every request.
const ENV = { PROXY_KV: {} };

// --- platform-specific pins -------------------------------------------------

test('[cloudflare] exports the Workers module shape { fetch, scheduled }', () => {
  assert.equal(typeof worker.default.fetch, 'function');
  assert.equal(typeof worker.default.scheduled, 'function');
  assert.ok(!('config' in worker.default));
});

test('[cloudflare] platform identity is Cloudflare Workers', async () => {
  const { body } = await jsonOf(await worker.default.fetch(req('/health'), ENV, null));
  assert.equal(body.platform, 'Cloudflare Workers');
});

test('[cloudflare] proxy pool is enabled and reports pool mode (raw sockets available)', async () => {
  const { body } = await jsonOf(await worker.default.fetch(req('/health'), ENV, null));
  assert.equal(body.proxy.enabled, true);
  // connect was injected, so the platform reports raw-socket support...
  assert.equal(body.proxy.poolSupported, true);
  // ...and pool + connect is the production outbound strategy on CF.
  assert.equal(body.proxy.mode, 'pool');
});

test('[cloudflare] no pre-response deadline (0 disables the deadline logic)', async () => {
  const { PRERESPONSE_DEADLINE_MS } = await import('../../src/platform.js');
  assert.equal(PRERESPONSE_DEADLINE_MS, 0);
});

test('[cloudflare] legacy /health compat fields (activeCount/lastUpdated/nextUpdate)', async () => {
  const { body } = await jsonOf(await worker.default.fetch(req('/health'), ENV, null));
  assert.ok('activeCount' in body);
  assert.equal(body.activeCount, 0);
  assert.equal(body.lastUpdated, null);
  assert.equal(body.nextUpdate, null);
});

// --- shared behavior suite --------------------------------------------------

registerAdapterSuite('cloudflare', (request, env, ctx) =>
  worker.default.fetch(request, env ?? ENV, ctx ?? null),
);

after(() => restoreEnv());
