import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFrame, usageCredit, prepareBody } from '../src/upstream.mjs';
import { normalizeChunk } from '../src/openai.mjs';

test('classifyFrame：正常 chunk', () => {
  const r = classifyFrame(JSON.stringify({ id: 'a', choices: [{ delta: { content: 'hi' } }] }));
  assert.equal(r.kind, 'chunk');
  assert.equal(r.obj.id, 'a');
});

test('classifyFrame：错误信封', () => {
  const r = classifyFrame(JSON.stringify({ code: 402, msg: '额度不足' }));
  assert.equal(r.kind, 'error');
  assert.equal(r.code, 402);
  assert.equal(r.message, '额度不足');
});

test('classifyFrame：非 JSON 视为 garbage', () => {
  assert.equal(classifyFrame('not json').kind, 'garbage');
});

test('usageCredit：多种字段名与字符串数值', () => {
  assert.equal(usageCredit({ credit: '0.06' }), 0.06);
  assert.equal(usageCredit({ credits: 1.5 }), 1.5);
  assert.equal(usageCredit({ total_credits: 2 }), 2);
  assert.equal(usageCredit({}, { credit: 0.5 }), 0.5);
  assert.equal(usageCredit(null, null), 0);
  assert.equal(usageCredit({ credit: 0 }), 0);
  assert.equal(usageCredit({ credit: 'x' }), 0);
});

test('prepareBody：强制流式 + 补 system + tool_choice 归一', () => {
  const cfg = { defaultSystemPrompt: 'SYS', stripFields: [] };
  const b = prepareBody(cfg, {
    messages: [{ role: 'user', content: 'hi' }],
    tool_choice: { type: 'function', function: { name: 'f' } },
  });
  assert.equal(b.stream, true);
  assert.equal(b.messages[0].role, 'system');
  assert.equal(b.messages[0].content, 'SYS');
  assert.equal(b.tool_choice, 'f');
});

test('prepareBody：developer 角色改写为 system（不再补默认 system）', () => {
  const cfg = { defaultSystemPrompt: 'SYS', stripFields: [] };
  const b = prepareBody(cfg, { messages: [{ role: 'developer', content: 'x' }] });
  assert.equal(b.messages.length, 1);
  assert.equal(b.messages[0].role, 'system');
});

test('prepareBody：stripFields 生效', () => {
  const cfg = { defaultSystemPrompt: 'SYS', stripFields: ['foo'] };
  const b = prepareBody(cfg, { messages: [{ role: 'system', content: 's' }], foo: 1 });
  assert.equal('foo' in b, false);
});

test('normalizeChunk：覆写 model、剥掉空 content、缺 usage 时不带 usage', () => {
  const out = normalizeChunk({ id: 'c1', model: 'real', choices: [{ index: 0, delta: { content: '' } }] }, 'pub');
  assert.equal(out.model, 'pub');
  assert.equal(out.upstream_model, 'real');
  assert.equal('usage' in out, false);
  assert.deepEqual(out.choices[0].delta, {});
});

test('normalizeChunk：有 usage 时带上', () => {
  const out = normalizeChunk({ choices: [], usage: { total_tokens: 3 } }, 'pub');
  assert.deepEqual(out.usage, { total_tokens: 3 });
});
