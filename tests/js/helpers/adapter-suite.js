// 🧪 Shared behavior suite: pins /health and routing for one adapter.
//
// Each platform adapter (cloudflare/worker.js, api/gemini.js,
// netlify/functions/gemini.js via shared-adapter) delegates to src/router.js.
// This suite asserts the contract every adapter must satisfy. It is
// instantiated once per adapter test file (tests/js/*.test.mjs), which run in
// separate processes — required because adapters mutate shared platform state
// (src/platform.js) at import time.
//
// `call(request, env, ctx)` is provided by each adapter test file and invokes
// that adapter's entry point exactly as its platform would.

import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * @param {string} label - adapter label for test names (e.g. 'cloudflare')
 * @param {Function} call - async (request, env, ctx) => Response
 */
export function registerAdapterSuite(label, call) {
  const NO_CTX = null;

  test(`[${label}] GET /health returns 200 with the pinned shape`, async () => {
    const res = await call(new Request('http://localhost/health'), null, NO_CTX);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');

    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.version, 'string');
    assert.ok(body.version.length > 0);
    assert.ok(Array.isArray(body.models) && body.models.length > 0);
    assert.ok(body.models.includes('gemini-3.6-flash'));
    assert.equal(typeof body.defaultModel, 'string');
    assert.equal(typeof body.geminiBl, 'string');
    assert.equal(body.hasCookie, false);
    assert.equal(body.hasSapisid, false);

    assert.ok(body.proxy && typeof body.proxy === 'object');
    assert.ok(['pool', 'outbound', 'direct'].includes(body.proxy.mode));
    assert.equal(typeof body.proxy.enabled, 'boolean');
    assert.equal(typeof body.proxy.poolSupported, 'boolean');
    // outbound-proxy env vars are scrubbed in tests → must be null
    assert.equal(body.proxy.outboundProxy, null);
  });

  test(`[${label}] GET / and GET /health are equivalent`, async () => {
    const a = await call(new Request('http://localhost/'), null, NO_CTX);
    const b = await call(new Request('http://localhost/health'), null, NO_CTX);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const ja = await a.json();
    const jb = await b.json();
    assert.deepEqual(ja.models, jb.models);
    assert.equal(ja.defaultModel, jb.defaultModel);
  });

  test(`[${label}] OPTIONS preflight returns 204 with CORS headers`, async () => {
    const res = await call(new Request('http://localhost/v1/chat/completions', { method: 'OPTIONS' }), null, NO_CTX);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
    assert.equal(res.headers.get('access-control-max-age'), '86400');
  });

  test(`[${label}] /v1/models requires an API key (401) and honors it`, async () => {
    const denied = await call(new Request('http://localhost/v1/models'), null, NO_CTX);
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).error.message, 'invalid api key');

    const ok = await call(new Request('http://localhost/v1/models', { headers: { 'x-api-key': 'sk-gemini' } }), null, NO_CTX);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.object, 'list');
    assert.ok(Array.isArray(body.data) && body.data.length > 0);
    for (const m of body.data) {
      assert.equal(m.object, 'model');
      assert.equal(m.owned_by, 'google');
      assert.equal(typeof m.description, 'string');
    }
  });

  test(`[${label}] Bearer token and ?key= auth also work`, async () => {
    const bearer = await call(new Request('http://localhost/v1/models', { headers: { authorization: 'Bearer sk-gemini' } }), null, NO_CTX);
    assert.equal(bearer.status, 200);

    const query = await call(new Request('http://localhost/v1/models?key=sk-gemini'), null, NO_CTX);
    assert.equal(query.status, 200);
  });

  test(`[${label}] routing: /v1beta/models (Google list) and 404 fallback`, async () => {
    const google = await call(new Request('http://localhost/v1beta/models', { headers: { 'x-api-key': 'sk-gemini' } }), null, NO_CTX);
    assert.equal(google.status, 200);
    const gBody = await google.json();
    assert.ok(Array.isArray(gBody.models) && gBody.models.length > 0);
    assert.ok(gBody.models[0].name.startsWith('models/'));
    assert.deepEqual(gBody.models[0].supportedGenerationMethods, ['generateContent', 'streamGenerateContent']);

    const missing = await call(new Request('http://localhost/definitely-not-a-route'), null, NO_CTX);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.message, 'not found');
  });

  test(`[${label}] routing: invalid JSON body on /v1/chat/completions -> 400`, async () => {
    const res = await call(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-api-key': 'sk-gemini', 'content-type': 'application/json' },
      body: 'definitely not json',
    }), null, NO_CTX);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.message, 'invalid JSON');
  });

  test(`[${label}] routing: unknown POST under /v1/ falls through to chat handler`, async () => {
    // The catch-all turns any /v1/* POST into a chat-completions request;
    // a malformed body must therefore surface the chat handler's 400/500
    // validation path, not the 404 "not found" route response.
    const res = await call(new Request('http://localhost/v1/some-unknown-endpoint', {
      method: 'POST',
      headers: { 'x-api-key': 'sk-gemini', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'no-such-model', messages: [] }),
    }), null, NO_CTX);
    const body = await res.json();
    assert.notEqual(res.status, 404);
    assert.ok(body.error && body.error.message);
  });

  test(`[${label}] env overrides propagate into per-request config (/health)`, async () => {
    // Netlify/Vercel handlers take (request, context) only — env reaches the
    // router via process.env (mergePlatformEnv). Cloudflare additionally
    // accepts an env object, but process.env works uniformly for all three.
    process.env.DEFAULT_MODEL = 'gemini-3.1-pro';
    try {
      const res = await call(new Request('http://localhost/health'), null, NO_CTX);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.defaultModel, 'gemini-3.1-pro');
    } finally {
      delete process.env.DEFAULT_MODEL;
    }
  });

  test(`[${label}] method not allowed -> 405`, async () => {
    const res = await call(new Request('http://localhost/health', { method: 'DELETE' }), null, NO_CTX);
    assert.equal(res.status, 405);
  });
}
