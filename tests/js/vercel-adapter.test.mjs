// 🧪 Vercel adapter tests (api/gemini.js).
//
// Runs in its own process (node --test) because the adapter mutates shared
// platform state (src/platform.js) at import time.

import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerAdapterSuite } from './helpers/adapter-suite.js';
import { setupTestEnv, req, jsonOf } from './helpers/env.js';

const restoreEnv = setupTestEnv();

// Vercel's runtime always sets VERCEL=1; the router's platform detection
// keys off it (EdgeRuntime global is absent under plain Node).
process.env.VERCEL = '1';

const { default: handler, config } = await import('../../api/gemini.js');

// -- platform-specific pins

test('[vercel] export const config pins the Edge runtime', () => {
  assert.deepEqual(config, { runtime: 'edge' });
});

test('[vercel] platform identity is Vercel Edge Functions', async () => {
  const { body } = await jsonOf(await handler(req('/health'), null));
  assert.equal(body.platform, 'Vercel Edge Functions');
});

test('[vercel] proxy pool is disabled by default and reports direct mode', async () => {
  const { body } = await jsonOf(await handler(req('/health'), null));
  assert.equal(body.proxy.mode, 'direct');
  assert.equal(body.proxy.enabled, false);
  assert.equal(body.proxy.poolSupported, false);
});

test('[vercel] pre-response deadline is 22s (Vercel 25s limit minus margin)', async () => {
  const { PRERESPONSE_DEADLINE_MS } = await import('../../src/platform.js');
  assert.equal(PRERESPONSE_DEADLINE_MS, 22 * 1000);
});

test('[vercel] x-matched-path rewrite is recovered (internal path -> public path)', async () => {
  // vercel.json rewrites map public paths onto /api/gemini; when the function
  // sees the internal path, the original one arrives via x-matched-path.
  const res = await handler(
    req('/api/gemini', { headers: { 'x-matched-path': '/health' } }),
    null,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
});

test('[vercel] canonical /api/gemini entry is treated as a health check', async () => {
  const res = await handler(req('/api/gemini'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
});

test('[vercel] handler also exposes .fetch and .scheduled', async () => {
  assert.equal(typeof handler.fetch, 'function');
  assert.equal(typeof handler.scheduled, 'function');
  const res = await handler.fetch(req('/health'), null, null);
  assert.equal(res.status, 200);
});

// -- shared behavior suite

registerAdapterSuite('vercel', (request, env, ctx) => handler(request, null, ctx ?? {}));

after(() => restoreEnv());
