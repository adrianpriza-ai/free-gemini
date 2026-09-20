// 🧪 Tool-calling parity tests for the shared JS core (src/).
//
// Mirrors tests/test_openai_compat.py:
//   - parseToolCalls: multi-format tool_call extraction + validNames filtering
//   - toolNames: declared function names from an OpenAI tools list
//   - streamToolCallsSSE: OpenAI-spec streaming tool_call deltas
//     (index on every delta, head carries id + name, arg slices reassemble,
//     finish_reason 'tool_calls', [DONE] terminator)

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseToolCalls, toolNames } from '../../src/gemini.js';
import { streamToolCallsSSE } from '../../src/handlers.js';

// -- helpers

/** Collect the `data: {...}` JSON chunks out of an SSE body. */
function parseChunks(sse) {
  return sse
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: {'))
    .map((frame) => JSON.parse(frame.slice('data: '.length)));
}

// -- parseToolCalls

test('parseToolCalls: canonical tool_call fence', () => {
  const text = 'Thinking...\n```tool_call\n{"name": "read", "arguments": {"filePath": "a.txt"}}\n```\ndone';
  const { cleanText, toolCalls } = parseToolCalls(text);
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.name, 'read');
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { filePath: 'a.txt' });
  assert.equal(toolCalls[0].type, 'function');
  assert.match(toolCalls[0].id, /^call_/);
  assert.ok(!cleanText.includes('tool_call'));
});

test('parseToolCalls: function_call fence variant', () => {
  const text = '```function_call\n{"name": "bash", "arguments": {"command": "ls"}}\n```';
  const { toolCalls } = parseToolCalls(text);
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.name, 'bash');
});

test('parseToolCalls: json fence with name is a tool call', () => {
  const text = '```json\n{"name": "read", "arguments": {"filePath": "a.txt"}}\n```';
  const { cleanText, toolCalls } = parseToolCalls(text);
  assert.equal(toolCalls.length, 1);
  assert.equal(cleanText, '');
});

test('parseToolCalls: json fence without name is left intact', () => {
  const text = 'Here is JSON:\n```json\n{"foo": 1}\n```';
  const { cleanText, toolCalls } = parseToolCalls(text);
  assert.deepEqual(toolCalls, []);
  assert.equal(cleanText, text);
});

test('parseToolCalls: bracket shorthand', () => {
  const text = 'Sure [tool_call: read {"filePath": "pyproject.toml"}] ok';
  const { cleanText, toolCalls } = parseToolCalls(text);
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.name, 'read');
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { filePath: 'pyproject.toml' });
  assert.ok(!cleanText.includes('tool_call'));
});

test('parseToolCalls: bracket shorthand tolerates trailing brace', () => {
  // Observed in the wild: model appends an extra closing brace.
  const text = '[tool_call: read { "filePath": "pyproject.toml" }}]';
  const { toolCalls } = parseToolCalls(text);
  assert.equal(toolCalls.length, 1);
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { filePath: 'pyproject.toml' });
});

test('parseToolCalls: args key accepted and raw JSON object fallback', () => {
  const text = '{"name": "bash", "args": {"command": "pwd"}}';
  const { cleanText, toolCalls } = parseToolCalls(text);
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.name, 'bash');
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { command: 'pwd' });
  assert.equal(cleanText, '');
});

test('parseToolCalls: string arguments are coerced to an object', () => {
  const text = '```tool_call\n{"name": "read", "arguments": "{\\"filePath\\": \\"a.txt\\"}"}\n```';
  const { toolCalls } = parseToolCalls(text);
  assert.equal(toolCalls.length, 1);
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { filePath: 'a.txt' });
});

test('parseToolCalls: plain prose returns no calls', () => {
  const text = 'The version is 1.1.0.';
  const { cleanText, toolCalls } = parseToolCalls(text);
  assert.deepEqual(toolCalls, []);
  assert.equal(cleanText, text);
});

test('parseToolCalls: validNames filters hallucinated tools', () => {
  const text = '```tool_call\n{"name": "read", "arguments": {}}\n```\n' +
               '```tool_call\n{"name": "nuke_drive", "arguments": {}}\n```';
  const { cleanText, toolCalls } = parseToolCalls(text, new Set(['read']));
  assert.deepEqual(toolCalls.map((c) => c.function.name), ['read']);
  assert.ok(!cleanText.includes('nuke_drive'));
});

test('parseToolCalls: json fence inside a tool_call body stops the outer span', () => {
  // Non-greedy fence matching (same as the Python impl) stops at the first
  // ``` — the leftover tail (a bare json fence without a name) stays intact.
  const text = '```tool_call\n{"name": "read", "arguments": {}}\n```json\n{}\n```';
  const { cleanText, toolCalls } = parseToolCalls(text);
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.name, 'read');
  // leftover: the 'json' fence label + its bare {} body, same as the Python impl
  assert.equal(cleanText, 'json\n{}\n```');
});

// -- toolNames

test('toolNames: extracts declared names from both tool formats', () => {
  const tools = [
    { type: 'function', function: { name: 'read' } },
    { type: 'function', function: { name: 'bash' } },
    { name: 'custom-thing' },
  ];
  assert.deepEqual([...toolNames(tools)].sort(), ['bash', 'custom-thing', 'read']);
  assert.equal(toolNames(null).size, 0);
  assert.equal(toolNames([]).size, 0);
});

// -- streamToolCallsSSE

test('streamToolCallsSSE: index on every delta, args reassemble exactly', async () => {
  const args = { filePath: 'pyproject.toml', extra: 'x'.repeat(300) }; // forces arg slicing
  const toolCalls = [{
    id: 'call_test1234',
    type: 'function',
    function: { name: 'read', arguments: JSON.stringify(args) },
  }];

  const sse = await new Response(
    streamToolCallsSSE('chatcmpl-abc', 'gemini-3.6-flash', toolCalls),
  ).text();
  const chunks = parseChunks(sse);

  // First chunk announces the assistant role.
  assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant' });

  // Every tool_calls delta carries an index; intermediate chunks are not final.
  const toolDeltas = chunks.map((c) => c.choices[0].delta).filter((d) => 'tool_calls' in d);
  assert.ok(toolDeltas.length > 1); // head + arg slices
  for (const delta of toolDeltas) {
    for (const tc of delta.tool_calls) assert.ok('index' in tc);
  }
  for (const chunk of chunks.slice(0, -1)) {
    assert.equal(chunk.choices[0].finish_reason, null);
  }

  // Head chunk carries id + name; arg slices reassemble exactly.
  const head = toolDeltas[0].tool_calls[0];
  assert.equal(head.index, 0);
  assert.equal(head.function.name, 'read');
  assert.match(head.id, /^call_/);
  const reassembled = toolDeltas
    .map((d) => d.tool_calls[0].function.arguments || '')
    .join('');
  assert.deepEqual(JSON.parse(reassembled), args);

  // Final chunk finishes with the tool_calls reason, then [DONE].
  assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'tool_calls');
  assert.ok(sse.endsWith('data: [DONE]\n\n'));
});

test('streamToolCallsSSE: multiple calls get sequential indices', async () => {
  const toolCalls = [
    { id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"filePath":"a.txt"}' } },
    { id: 'call_b', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
  ];

  const sse = await new Response(
    streamToolCallsSSE('chatcmpl-abc', 'gemini-3.6-flash', toolCalls),
  ).text();
  const toolDeltas = parseChunks(sse)
    .map((c) => c.choices[0].delta)
    .filter((d) => 'tool_calls' in d);

  const heads = toolDeltas.filter((d) => d.tool_calls[0].id);
  assert.deepEqual(heads.map((d) => d.tool_calls[0].index), [0, 1]);
  assert.deepEqual(heads.map((d) => d.tool_calls[0].function.name), ['read', 'bash']);
});
