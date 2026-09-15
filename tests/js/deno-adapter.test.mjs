// 🧪 Deno Deploy adapter tests (deno/deploy.js).
//
// Runs in its own process (node --test) because the adapter mutates shared
// platform state (src/platform.js) at import time.
//
// Mirrors the Deno runtime the way vercel-adapter.test.mjs pins VERCEL=1:
// a minimal global `Deno` stub lets the router's platform detection and
// mergePlatformEnv behave as they do on Deno Deploy. The stub's serve() is a
// no-op — binding a real port only happens in the live `deno run` smoke test
// (package.json `test:deno:serve`).

globalThis.Deno = {
  serve: function () { return {}; },
  env: { toObject: function () { return {}; } },
};

import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerAdapterSuite } from './helpers/adapter-suite.js';
import { setupTestEnv, req, jsonOf } from './helpers/env.js';

const restoreEnv = setupTestEnv();

const adapter = await import('../../deno/deploy.js');
const handler = adapter.default;

// -- platform-specific pins

test('[deno] default export is the handler with .scheduled attached', () => {
  assert.equal(typeof handler, 'function');
  assert.equal(typeof handler.scheduled, 'function');
});

test('[deno] platform identity is Deno Deploy', async () => {
  const { body } = await jsonOf(await handler(req('/health'), null, null));
  assert.equal(body.platform, 'Deno Deploy');
});

test('[deno] proxy pool is disabled by default and reports direct mode', async () => {
  const { body } = await jsonOf(await handler(req('/health'), null, null));
  assert.equal(body.proxy.mode, 'direct');
  assert.equal(body.proxy.enabled, false);
  // connect (wrapped Deno.connect) is injected, so raw sockets are supported.
  assert.equal(body.proxy.poolSupported, true);
});

test('[deno] pre-response deadline is 55s (anti-hang guard, no platform hard limit)', async () => {
  const { PRERESPONSE_DEADLINE_MS } = await import('../../src/platform.js');
  assert.equal(PRERESPONSE_DEADLINE_MS, 55 * 1000);
});

test('[deno] handler is directly callable (Deno.serve signature)', async () => {
  const a = await handler(req('/health'));
  assert.equal(a.status, 200);
  const body = await a.json();
  assert.equal(body.status, 'ok');
});

// -- shared behavior suite

registerAdapterSuite('deno', (request, env, ctx) => handler(request, env, ctx ?? null));

after(() => restoreEnv());
