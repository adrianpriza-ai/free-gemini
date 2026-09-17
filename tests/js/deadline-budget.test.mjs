// 🧪 REQUEST_DEADLINE_MS alignment tests (src/gemini.js + src/router.js).
//
// Regression coverage for the "upstream timeout: no response within 50000ms
// (REQUEST_DEADLINE_MS)" symptom on Deno Deploy:
//   1. The non-streaming retry loop must budget against the router's total
//      deadline (REQUEST_DEADLINE_MS minus a 3s margin), not just the platform
//      pre-response deadline (55s on Deno) — otherwise retries overrun the
//      router deadline and the real upstream error is masked by the generic
//      upstream_timeout 502.
//   2. A per-attempt timeout must surface a readable error (not a bare
//      "The operation was aborted" AbortError).
//   3. The response-body read must also be deadline-bound.
//   4. The router's deadline 502 message must carry actionable hints.
//
// Runs in its own process (node --test runs each file separately), so mutating
// src/platform.js state here cannot leak into the adapter suites.

import assert from 'node:assert/strict';
import test from 'node:test';

// -- Platform state: mimic the Deno Deploy adapter (55s pre-response deadline,
//    no raw sockets, proxy pool off) without importing deno/deploy.js (which
//    would call Deno.serve under the stub).
const platform = await import('../../src/platform.js');
platform.setProxyPoolDefaultEnabled(false);
platform.setPreresponseDeadline(55 * 1000);
platform.setPlatformConnect(null, 'Deadline Test');

const { geminiStreamGenerate } = await import('../../src/gemini.js');
const { handleRequestSafe } = await import('../../src/router.js');

// -- A fetch() that never resolves: simulates a silent upstream (the exact
//    condition behind the user-visible 502). The signal is intentionally
//    ignored; per-attempt timeouts still fire because the retry loop races
//    its own attemptTimeoutMs deadline against the promise... except the
//    non-streaming path awaits geminiFetch directly and relies on
//    AbortController — so the stub must honor the signal by rejecting.
const realFetch = globalThis.fetch;
function hangUntilAborted() {
  globalThis.fetch = function (url, options) {
    return new Promise(function (resolve, reject) {
      if (options && options.signal) {
        if (options.signal.aborted) return reject(new Error('The operation was aborted'));
        options.signal.addEventListener('abort', function () {
          reject(new Error('The operation was aborted'));
        });
      }
      // Never resolves on its own — upstream stays silent.
    });
  };
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

/** Base config mirroring src/config.js defaults for a Deno-like request. */
function makeConfig(overrides) {
  var config = {
    retryAttempts: 3,
    retryDelaySec: 0, // no backoff waits → elapsed time == attempt timeouts
    requestTimeoutSec: 1,
    requestDeadlineMs: 50000,
    fingerprintJitterMs: 0,
    authUser: null,
    xsrfToken: null,
    cookieString: null,
    sapisid: null,
    geminiBl: 'boq_assistant-bard-web-server_20260907.07_p0',
    defaultModel: 'gemini-3.6-flash',
    logRequests: false,
    proxy: { enabled: false, fallbackDirect: true },
    _requestStartMs: Date.now(),
    _env: {},
    _ctx: null,
    _platform: 'Deadline Test',
  };
  if (overrides) {
    for (var k in overrides) config[k] = overrides[k];
  }
  return config;
}

test('retry loop stops at the router deadline instead of the 55s platform deadline', async () => {
  hangUntilAborted();
  try {
    // Router deadline = start + 8s − 3s margin = start + 5s. Without the
    // router binding, 10 attempts × 1s ≈ 10s would run out under the 55s
    // platform deadline; with it, the loop must bail after ~3 attempts (~3s).
    var t0 = Date.now();
    await assert.rejects(
      geminiStreamGenerate('hi', 1, 4, makeConfig({ retryAttempts: 10, requestDeadlineMs: 8000 })),
      /上游请求超时/,
    );
    var elapsed = Date.now() - t0;
    assert.ok(elapsed < 5000, 'retry loop overran the router deadline: ' + elapsed + 'ms');
  } finally {
    restoreFetch();
  }
});

test('per-attempt timeout produces a readable error, not a bare AbortError', async () => {
  hangUntilAborted();
  try {
    // Default 50s deadline → budget (47s) does not interfere; the 1s
    // attempt timeout must surface the wrapped, actionable message.
    await assert.rejects(
      geminiStreamGenerate('hi', 1, 4, makeConfig({ retryAttempts: 1 })),
      function (err) {
        assert.match(err.message, /上游请求超时（单次尝试 1000ms/);
        assert.match(err.message, /COOKIE_STRING/);
        assert.doesNotMatch(err.message, /^The operation was aborted$/);
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

test('response-body read is raced against the deadline', async () => {
  // Headers arrive instantly (status 200) but the body never delivers —
  // previously response.text() would hang until the router 502 masked it.
  var bodyStall = new ReadableStream({ start: function () { /* never enqueues */ } });
  globalThis.fetch = function () {
    return Promise.resolve(new Response(bodyStall, { status: 200 }));
  };
  try {
    var t0 = Date.now();
    await assert.rejects(
      geminiStreamGenerate('hi', 1, 4, makeConfig({ retryAttempts: 1, requestDeadlineMs: 7000 })),
      /响应体读取超时/,
    );
    var elapsed = Date.now() - t0;
    assert.ok(elapsed < 5000, 'body read was not deadline-bound: ' + elapsed + 'ms');
  } finally {
    restoreFetch();
  }
});

test('a fast, healthy upstream still resolves normally (no regression)', async () => {
  globalThis.fetch = function () {
    return Promise.resolve(new Response('46\n[[["wrb.fr",null,"123"]]]\n', { status: 200 }));
  };
  try {
    var text = await geminiStreamGenerate('hi', 1, 4, makeConfig({}));
    assert.ok(typeof text === 'string');
  } finally {
    restoreFetch();
  }
});

test('legacy callers without _requestStartMs keep the platform-deadline behavior', async () => {
  hangUntilAborted();
  try {
    var config = makeConfig({ retryAttempts: 1 });
    delete config._requestStartMs; // direct/legacy call convention
    await assert.rejects(
      geminiStreamGenerate('hi', 1, 4, config),
      /上游请求超时（单次尝试 1000ms/,
    );
  } finally {
    restoreFetch();
  }
});

test('handleRequestSafe 502 deadline message carries actionable hints', async () => {
  // Pending work (a hanging proxy-source fetch) + a 1.5s router deadline →
  // the structured upstream_timeout 502. The message must now tell the user
  // what to do instead of only naming the env var.
  var savedDeadline = process.env.REQUEST_DEADLINE_MS;
  var savedProxy = process.env.ENABLE_PROXY;
  process.env.REQUEST_DEADLINE_MS = '1500';
  process.env.ENABLE_PROXY = 'true'; // keep /proxies/refresh inside fetch()
  hangUntilAborted();
  try {
    var t0 = Date.now();
    var res = await handleRequestSafe(
      new Request('http://localhost/proxies/refresh', { headers: { 'x-api-key': 'sk-gemini' } }),
      null,
      null,
    );
    var elapsed = Date.now() - t0;
    assert.equal(res.status, 502);
    var body = await res.json();
    assert.equal(body.error.type, 'upstream_timeout');
    assert.match(body.error.message, /COOKIE_STRING/);
    assert.match(body.error.message, /REQUEST_DEADLINE_MS/);
    assert.ok(elapsed < 5000, 'router deadline fired late: ' + elapsed + 'ms');
  } finally {
    restoreFetch();
    if (savedDeadline === undefined) delete process.env.REQUEST_DEADLINE_MS;
    else process.env.REQUEST_DEADLINE_MS = savedDeadline;
    if (savedProxy === undefined) delete process.env.ENABLE_PROXY;
    else process.env.ENABLE_PROXY = savedProxy;
  }
});

// =====================================================================
// 429 attribution: a real upstream 429 must surface as "HTTP 429: ...
// 请添加有效的 Cookie 或降低请求频率", never as the generic
// upstream_timeout 502. Regression for the Retry-After wait eating the
// deadline budget and masking the 429.
// =====================================================================

/**
 * fetch() stub that answers every call with a 429 response.
 * trackWaitMs records how long the retry loop actually slept, so tests can
 * assert the loop did NOT burn the whole budget on a doomed Retry-After wait.
 */
function always429() {
  var realNow = Date.now;
  var waits = [];
  globalThis.fetch = function () {
    return Promise.resolve(new Response('rate limited', {
      status: 429,
      headers: { 'Retry-After': '120' }, // 120s — far beyond any budget
    }));
  };
  Date.now = function () { return realNow() + (waits._advance || 0); };
  return {
    waits: waits,
    /** Simulate the sleep: advance the virtual clock to the requested time. */
    advanceTo: function (t) { waits._advance = t - realNow(); },
    restore: function () { Date.now = realNow; },
  };
}

// Patch global setTimeout inside always429 tests so sleeps resolve instantly
// while recording their duration — keeps the suite fast and deterministic.
function withInstantTimers(fn) {
  var realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = function (cb, ms) {
    return realSetTimeout(function () {
      // Record sleep durations >= 1000ms (retry/Retry-After waits), ignore
      // tiny timer artifacts (body-read race timers, abort timers).
      if (typeof ms === 'number' && ms >= 1000) waits.push(ms);
      cb();
    }, 0);
  };
  try {
    return fn();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

test('upstream 429 with huge Retry-After surfaces the real 429 (non-streaming), not a timeout', async () => {
  var handle = always429();
  try {
    await withInstantTimers(async function () {
      // Default deadline (50s): Retry-After 120s can never fit — the loop
      // must throw the real 429 on the first attempt instead of sleeping.
      await assert.rejects(
        geminiStreamGenerate('hi', 1, 4, makeConfig({ retryAttempts: 3 })),
        function (err) {
          assert.match(err.message, /HTTP 429: Too Many Requests/);
          assert.doesNotMatch(err.message, /超时|abort/);
          return true;
        },
      );
    });
    // The doomed 120s wait must never have been taken.
    assert.ok(handle.waits.indexOf(120000) === -1, 'retry loop slept the full Retry-After: ' + JSON.stringify(handle.waits));
  } finally {
    handle.restore();
    restoreFetch();
  }
});

test('upstream 429 with a small Retry-After still retries within budget (non-streaming)', async () => {
  var calls = 0;
  globalThis.fetch = function () {
    calls++;
    if (calls < 3) return Promise.resolve(new Response('rate limited', { status: 429, headers: { 'Retry-After': '1' } }));
    return Promise.resolve(new Response('46\n[[["wrb.fr",null,"123"]]]\n', { status: 200 }));
  };
  try {
    await withInstantTimers(async function () {
      var text = await geminiStreamGenerate('hi', 1, 4, makeConfig({ retryAttempts: 3, requestDeadlineMs: 50000 }));
      assert.ok(typeof text === 'string');
    });
    assert.equal(calls, 3);
  } finally {
    restoreFetch();
  }
});

test('upstream 429 with huge Retry-After surfaces the real 429 (streaming path)', async () => {
  var handle = always429();
  try {
    await withInstantTimers(async function () {
      var config = makeConfig({ retryAttempts: 3 });
      // Streaming path lives in handleChatCompletions(request, body, config).
      var { handleChatCompletions } = await import('../../src/handlers.js');
      var res = await handleChatCompletions(
        new Request('http://localhost/v1/chat/completions'),
        { model: 'gemini-3.6-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] },
        config,
      );
      assert.equal(res.status, 200); // SSE headers go out immediately; the error rides inside the stream
      var sseBody = await res.text();
      // The streamed SSE error chunk must carry the real 429 message.
      assert.match(sseBody, /HTTP 429: Too Many Requests/);
      assert.match(sseBody, /upstream_error/);
      assert.doesNotMatch(sseBody, /upstream timeout|REQUEST_DEADLINE_MS/);
    });
    assert.ok(handle.waits.indexOf(120000) === -1, 'streaming loop slept the full Retry-After: ' + JSON.stringify(handle.waits));
  } finally {
    handle.restore();
    restoreFetch();
  }
});
