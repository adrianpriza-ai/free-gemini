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

test('[netlify] HTTPS_PROXY env var switches /health proxy.mode to outbound', async () => {
  // Netlify Edge runs on Deno, whose fetch() natively tunnels through
  // HTTPS_PROXY/HTTP_PROXY/ALL_PROXY. The shared core only parses/reports the
  // var (config.outboundProxy) — the tunneling itself is the runtime's job.
  process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
  try {
    const { body } = await jsonOf(await handler(req('/health'), null));
    assert.equal(body.proxy.mode, 'outbound');
    assert.equal(body.proxy.enabled, true);
    assert.equal(body.proxy.outboundProxy, '(set)');
    // The pool stays unsupported: no raw TCP sockets on Netlify Edge.
    assert.equal(body.proxy.poolSupported, false);
  } finally {
    delete process.env.HTTPS_PROXY;
  }
});

test('[netlify] ENABLE_PROXY=true degrades gracefully to outbound/direct (no crash)', async () => {
  // The rotating proxy pool needs raw TCP sockets (connect === null here), so
  // ENABLE_PROXY is ignored with a WARN; requests must still work.
  process.env.ENABLE_PROXY = 'true';
  try {
    const { body } = await jsonOf(await handler(req('/health'), null));
    assert.equal(body.proxy.poolSupported, false);
    assert.ok(['direct', 'outbound'].includes(body.proxy.mode));
  } finally {
    delete process.env.ENABLE_PROXY;
  }
});

test('[netlify] HTTP_PROXY and ALL_PROXY are also recognized as outbound proxies', async () => {
  for (const key of ['HTTP_PROXY', 'ALL_PROXY', 'https_proxy']) {
    process.env[key] = 'http://127.0.0.1:7890';
    try {
      const { body } = await jsonOf(await handler(req('/health'), null));
      assert.equal(body.proxy.mode, 'outbound', key + ' should report outbound mode');
    } finally {
      delete process.env[key];
    }
  }
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
