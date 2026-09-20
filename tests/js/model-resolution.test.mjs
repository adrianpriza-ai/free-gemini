// 🧪 Model resolution tests for src/http.js resolveModel.
//
// Pins the Python-parity fallback (gemini_web2api/models.py resolve_model):
// unknown model names resolve to the default model instead of erroring,
// since upstream clients may request arbitrary model identifiers (gpt-4o etc.).
// The @think= override, invalid-think and missing-model error paths are
// pinned too, so the fallback cannot silently swallow them.

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveModel } from '../../src/http.js';
import { buildPayload } from '../../src/gemini.js';

test('resolveModel: known model resolves to its config', () => {
  const r = resolveModel('gemini-3.6-flash');
  assert.equal(r.error, null);
  assert.equal(r.modelName, 'gemini-3.6-flash');
  assert.equal(r.modelId, 1);
  assert.equal(r.thinkMode, 4);
});

test('resolveModel: unknown name falls back to the built-in default', () => {
  const r = resolveModel('gpt-4o-turbo');
  assert.equal(r.error, null);
  assert.equal(r.modelName, 'gemini-3.6-flash');
  assert.equal(r.modelId, 1);
  assert.equal(r.thinkMode, 4);
});

test('resolveModel: unknown name falls back to the provided default', () => {
  const r = resolveModel('no-such-model', 'gemini-3.1-pro');
  assert.equal(r.error, null);
  assert.equal(r.modelName, 'gemini-3.1-pro');
  assert.equal(r.modelId, 3);
});

test('resolveModel: unknown name with @think= keeps the think override', () => {
  const r = resolveModel('gpt-4o@think=0', 'gemini-3.5-flash-thinking');
  assert.equal(r.error, null);
  assert.equal(r.modelName, 'gemini-3.5-flash-thinking');
  assert.equal(r.thinkMode, 0);
});

test('resolveModel: @think= override on a known model still works', () => {
  const r = resolveModel('gemini-3.6-flash@think=2');
  assert.equal(r.error, null);
  assert.equal(r.modelName, 'gemini-3.6-flash');
  assert.equal(r.thinkMode, 2);
});

test('resolveModel: invalid @think= value still errors', () => {
  const r = resolveModel('gemini-3.6-flash@think=abc');
  assert.ok(r.error);
  assert.match(r.error, /think/);
});

test('resolveModel: missing model still errors', () => {
  assert.equal(resolveModel(null).error, 'missing model');
  assert.equal(resolveModel(undefined).error, 'missing model');
});

test('resolveModel: empty-string model falls back to the default', () => {
  const r = resolveModel('');
  assert.equal(r.error, null);
  assert.equal(r.modelName, 'gemini-3.6-flash');
});

// -- extra payload fields (gemini-3.1-pro-enhanced) --------------------------

test('resolveModel: gemini-3.1-pro-enhanced carries extra payload fields', () => {
  const r = resolveModel('gemini-3.1-pro-enhanced');
  assert.equal(r.error, null);
  assert.equal(r.modelId, 3);
  assert.deepEqual(r.extra, { 31: 2, 80: 3 });
});

test('resolveModel: models without extra resolve to null', () => {
  assert.equal(resolveModel('gemini-3.6-flash').extra, null);
  assert.equal(resolveModel('gemini-3.1-pro').extra, null);
});

/** Decode a buildPayload body back into the inner payload array. */
function decodeInner(body) {
  const outer = JSON.parse(new URLSearchParams(body).get('f.req'));
  return JSON.parse(outer[1]);
}

test('buildPayload: extraFields merge into the payload array', () => {
  const inner = decodeInner(buildPayload('hi', 3, 4, { xsrfToken: '' }, { 31: 2, 80: 3 }));
  assert.equal(inner[31], 2);
  assert.equal(inner[80], 3);
  assert.equal(inner[79], 3);
});

test('buildPayload: without extraFields the base payload is untouched', () => {
  const inner = decodeInner(buildPayload('hi', 3, 4, { xsrfToken: '' }));
  assert.equal(inner[31], null);
  assert.equal(inner[80], undefined);
  assert.equal(inner.length, 80);
  assert.equal(inner[79], 3);
});
