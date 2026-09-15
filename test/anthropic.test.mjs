import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toOpenAIBody } from '../src/anthropic.mjs';

test('toOpenAIBody：system + 用户消息 + 默认流式', () => {
  const b = toOpenAIBody({ model: 'm', system: 'S', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(b.model, 'm');
  assert.equal(b.messages[0].role, 'system');
  assert.equal(b.messages[0].content, 'S');
  assert.equal(b.messages[1].content, 'hi');
  assert.equal(b.stream, true);
});

test('toOpenAIBody：tool_use → tool_calls，tool_result → tool 消息', () => {
  const b = toOpenAIBody({
    model: 'm',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'f', input: { a: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ],
  });
  assert.equal(b.messages[0].role, 'assistant');
  assert.equal(b.messages[0].tool_calls[0].function.name, 'f');
  assert.equal(b.messages[0].tool_calls[0].function.arguments, '{"a":1}');
  assert.equal(b.messages[1].role, 'tool');
  assert.equal(b.messages[1].tool_call_id, 't1');
  assert.equal(b.messages[1].content, 'ok');
});

test('toOpenAIBody：tools 与 tool_choice 映射（any → required）', () => {
  const b = toOpenAIBody({
    model: 'm',
    messages: [],
    tools: [{ name: 'f', description: 'd', input_schema: { type: 'object' } }],
    tool_choice: { type: 'any' },
  });
  assert.equal(b.tools[0].type, 'function');
  assert.equal(b.tools[0].function.name, 'f');
  assert.equal(b.tool_choice, 'required');
});
