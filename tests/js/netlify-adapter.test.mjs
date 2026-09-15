// 🧪 Netlify adapter tests (netlify/functions/gemini.js + netlify/edge-functions/gemini.js).
//
// Both entries re-export netlify/shared-adapter.js, so this file pins them
// together. Runs in its own process (node --test) because the adapter mutates
// shared platform state (src/platform.js) at import time.

import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerAdapterSuite } from './helpers/adapter-suite.js';
import { setupTestEnv, req, jsonOf } from './helpers/env.js';

const restoreEnv = setupTestEnv();

const handler = (await import('../../netlify/shared-adapter.js')).default;

// -- platform-specific pins

test('[netlify] platform identity is Netlify Edge Functions', async () => {
  const { body } = await jsonOf(await handler(req('/health'), null));
  assert.equal(body.platform, 'Netlify Edge Functions');
});

test('[netlify] proxy pool is disabled by default and reports direct mode', async () => {
  const { body } = await jsonOf(await handler(req('/health'), null));
  assert.equal(body.proxy.mode, 'direct');
  assert.equal(body.proxy.enabled, false);
  assert.equal(body.proxy.poolSupported, false);
});

test('[netlify] pre-response deadline is 30s (Netlify 40s limit minus margin)', async () => {
  const { PRERESPONSE_DEADLINE_MS } = await import('../../src/platform.js');
  assert.equal(PRERESPONSE_DEADLINE_MS, 30 * 1000);
});

test('[netlify] handler also exposes .fetch and .scheduled', async () => {
  assert.equal(typeof handler.fetch, 'function');
  assert.equal(typeof handler.scheduled, 'function');

  // .fetch must behave identically to the default export.
  const res = await handler.fetch(req('/health'), null, null);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
});

// -- shared behavior suite

registerAdapterSuite('netlify', (request, env, ctx) => handler(request, null, ctx ?? {}));

after(() => restoreEnv());
