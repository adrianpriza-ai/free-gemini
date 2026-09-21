// 🧪 Empty-upstream-response tests (src/handlers.js).
//
// Regression for the Deno Deploy symptom where a chat completion came back as
//   {"choices":[{"message":{"role":"assistant","content":null},
//                "finish_reason":"stop"}],
//    "usage":{"prompt_tokens":2,"completion_tokens":0,"total_tokens":2}}
// i.e. HTTP 200 with a null content and zero completion tokens.
//
// Root cause: Gemini silently throttles anonymous / datacenter egress (Deno
// Deploy's shared edge IPs) by answering 200 with an empty body instead of
// 429/5xx. extractResponseText yields '' for such a body and the handlers used
// to return it as a *successful* empty completion, hiding the real failure.
// The guard must now surface it as an actionable 502.
//
// Runs in its own process (node --test runs each file separately), so mutating
// src/platform.js state here cannot leak into the other suites.

import assert from 'node:assert/strict';
import test from 'node:test';

// -- Platform state: mimic a Deno-like deployment (no raw sockets, no
//    pre-response deadline so the body read is a plain response.text()).
const platform = await import('../../src/platform.js');
platform.setProxyPoolDefaultEnabled(false);
platform.setPreresponseDeadline(0);
platform.setPlatformConnect(null, 'Empty Response Test');

const { handleChatCompletions, handleGoogleAPI } = await import('../../src/handlers.js');

const realFetch = globalThis.fetch;
function stubFetch(responder) {
  globalThis.fetch = responder;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

/**
 * Build one Gemini StreamGenerate data line carrying `text`.
 * Shape: [ [ ["wrb.fr", null, "<inner json>"] ] ] where inner[4][0][1] is the
 * text array extractResponseText reads. Padded past the parser's length guards
 * (line >= 200 chars, inner JSON >= 50 chars).
 */
function upstreamLine(text) {
  var inner = [];
  // Unused leading index, padded so the serialized line clears the parser's
  // >= 200-char guard (real Gemini lines carry the full conversation metadata).
  inner[0] = 'x'.repeat(240);
  inner[4] = [[0, [text]]];
  return JSON.stringify([['wrb.fr', null, JSON.stringify(inner)]]);
}

function makeConfig(overrides) {
  var config = {
    retryAttempts: 1,
    retryDelaySec: 0,
    requestTimeoutSec: 5,
    requestDeadlineMs: 0,
    fingerprintJitterMs: 0,
    authUser: null,
    xsrfToken: null,
    cookieString: null,
    sapisid: null,
    geminiBl: 'boq_assistant-bard-web-server_20260907.07_p0',
    defaultModel: 'gemini-3.6-flash',
    logRequests: false,
    proxy: { enabled: false, fallbackDirect: true },
    _env: {},
    _ctx: null,
    _platform: 'Empty Response Test',
  };
  if (overrides) {
    for (var k in overrides) config[k] = overrides[k];
  }
  return config;
}

function chatRequest(body) {
  return new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'x-api-key': 'sk-gemini', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('non-streaming chat: empty upstream body becomes an actionable 502', async () => {
  stubFetch(function () {
    // 200 + empty body — the silent-throttle shape.
    return Promise.resolve(new Response('', { status: 200 }));
  });
  try {
    var res = await handleChatCompletions(
      chatRequest({ model: 'gemini-3.6-flash', messages: [{ role: 'user', content: 'hello' }] }),
      { model: 'gemini-3.6-flash', messages: [{ role: 'user', content: 'hello' }] },
      makeConfig({}),
    );
    assert.equal(res.status, 502);
    var body = await res.json();
    assert.match(body.error.message, /空响应/);
    assert.match(body.error.message, /COOKIE_STRING/);
    assert.match(body.error.message, /ENABLE_PROXY/);
  } finally {
    restoreFetch();
  }
});

test('non-streaming chat: a 200 whose body has no extractable text is also a 502', async () => {
  stubFetch(function () {
    // Structurally valid stream framing but no content part — e.g. a
    // rate-limit notice rather than an answer.
    return Promise.resolve(new Response('46\n[[["wrb.fr",null,"123"]]]\n', { status: 200 }));
  });
  try {
    var res = await handleChatCompletions(
      chatRequest({ model: 'gemini-3.6-flash', messages: [{ role: 'user', content: 'hi' }] }),
      { model: 'gemini-3.6-flash', messages: [{ role: 'user', content: 'hi' }] },
      makeConfig({}),
    );
    assert.equal(res.status, 502);
  } finally {
    restoreFetch();
  }
});

test('non-streaming chat: a healthy upstream still returns the text (no regression)', async () => {
  var answer = 'Hello! How can I help you today?';
  stubFetch(function () {
    return Promise.resolve(new Response(upstreamLine(answer), { status: 200 }));
  });
  try {
    var res = await handleChatCompletions(
      chatRequest({ model: 'gemini-3.6-flash', messages: [{ role: 'user', content: 'hello' }] }),
      { model: 'gemini-3.6-flash', messages: [{ role: 'user', content: 'hello' }] },
      makeConfig({}),
    );
    assert.equal(res.status, 200);
    var body = await res.json();
    assert.equal(body.choices[0].message.content, answer);
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.ok(body.usage.completion_tokens > 0);
  } finally {
    restoreFetch();
  }
});

test('tools: a response that strips to nothing (hallucinated call only) is a 502', async () => {
  stubFetch(function () {
    // The model returns only a tool call for a name the caller never declared;
    // parseToolCalls removes it and yields neither text nor tool_calls.
    return Promise.resolve(new Response(upstreamLine('```tool_call\n{"name":"nuke_drive","arguments":{}}\n```'), { status: 200 }));
  });
  try {
    var body = {
      model: 'gemini-3.6-flash',
      messages: [{ role: 'user', content: 'do something' }],
      tools: [{ type: 'function', function: { name: 'read', description: 'read', parameters: { type: 'object' } } }],
    };
    var res = await handleChatCompletions(chatRequest(body), body, makeConfig({}));
    assert.equal(res.status, 502);
    var out = await res.json();
    assert.match(out.error.message, /没有可用文本或工具调用/);
  } finally {
    restoreFetch();
  }
});

test('streaming chat: empty upstream body surfaces an error chunk, not an empty finish', async () => {
  stubFetch(function () {
    return Promise.resolve(new Response('', { status: 200 }));
  });
  try {
    var body = { model: 'gemini-3.6-flash', stream: true, messages: [{ role: 'user', content: 'hello' }] };
    var res = await handleChatCompletions(chatRequest(body), body, makeConfig({}));
    assert.equal(res.status, 200); // SSE headers are already out
    var sse = await res.text();
    assert.match(sse, /"type":"upstream_error"/);
    assert.match(sse, /空响应/);
    // The terminating chunk must be an error finish, never a clean 'stop'.
    assert.doesNotMatch(sse, /"finish_reason":"stop"/);
    assert.match(sse, /"finish_reason":"error"/);
  } finally {
    restoreFetch();
  }
});

test('Google generateContent: empty upstream body becomes a 502', async () => {
  stubFetch(function () {
    return Promise.resolve(new Response('', { status: 200 }));
  });
  try {
    var googleBody = { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] };
    var req = new Request('http://localhost/v1beta/models/gemini-3.6-flash:generateContent', {
      method: 'POST',
      headers: { 'x-api-key': 'sk-gemini', 'content-type': 'application/json' },
      body: JSON.stringify(googleBody),
    });
    var res = await handleGoogleAPI(req, googleBody, false, makeConfig({}));
    assert.equal(res.status, 502);
  } finally {
    restoreFetch();
  }
});
