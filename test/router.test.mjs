import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMultiplier, resolveTarget, clearCatalog } from '../src/router.mjs';

// 用「不存在的站点键」构造配置：isLoggedIn 为 false，目录拉取不会触发网络请求
const cfg = {
  defaultSite: 'a',
  defaultModel: 'def-model',
  sites: { a: { enabled: true, seedModels: [] }, b: { enabled: true, seedModels: [] } },
  modelAliases: {},
  modelRoutes: {},
};

test('parseMultiplier', () => {
  assert.equal(parseMultiplier('x0.79 credits'), 0.79);
  assert.equal(parseMultiplier('x0.00 credits'), 0);
  assert.equal(parseMultiplier(''), Infinity);
  assert.equal(parseMultiplier(undefined), Infinity);
});

test('resolveTarget：default → 默认模型', async () => {
  clearCatalog();
  const t = await resolveTarget(cfg, 'default');
  assert.equal(t.model, 'def-model');
  assert.equal(t.site, 'a');
  assert.equal(t.requested, 'def-model');
});

test('resolveTarget：显式站点前缀', async () => {
  const t = await resolveTarget(cfg, 'b/some-model');
  assert.equal(t.site, 'b');
  assert.equal(t.model, 'some-model');
});

test('resolveTarget：别名可带站点前缀', async () => {
  const c2 = { ...cfg, modelAliases: { fast: 'b/some-model' } };
  const t = await resolveTarget(c2, 'fast');
  assert.equal(t.site, 'b');
  assert.equal(t.model, 'some-model');
});

test('resolveTarget：modelRoutes 固定站点', async () => {
  const c2 = { ...cfg, modelRoutes: { claude: 'b' } };
  const t = await resolveTarget(c2, 'claude');
  assert.equal(t.site, 'b');
  assert.equal(t.model, 'claude');
});

test('resolveTarget：目录无命中回落默认站点', async () => {
  clearCatalog();
  const t = await resolveTarget(cfg, 'unknown-model');
  assert.equal(t.site, 'a');
  assert.equal(t.model, 'unknown-model');
});

test('resolveTarget：空模型名回落默认模型', async () => {
  const t = await resolveTarget(cfg, '');
  assert.equal(t.model, 'def-model');
});
