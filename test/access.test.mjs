import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashKey, maskKey, generateKey, isIpAllowed, scopeAllows,
  checkRate, acquireSlot, releaseSlot, resolvePrincipal, authorizeRequest,
} from '../src/access.mjs';

test('hashKey：稳定且不可逆（sha256 十六进制）', () => {
  const a = hashKey('wb-test');
  assert.equal(a, hashKey('wb-test'));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, hashKey('wb-test2'));
  assert.ok(!a.includes('wb-test'), '哈希不应包含明文');
});

test('generateKey：带前缀且每次不同', () => {
  const k1 = generateKey();
  const k2 = generateKey();
  assert.ok(k1.startsWith('wb-'));
  assert.notEqual(k1, k2);
  assert.ok(k1.length > 20);
});

test('maskKey：只露首尾', () => {
  const id = 'abcdef1234567890abcdef1234567890';
  const m = maskKey(id);
  assert.ok(m.startsWith('abcdef12'));
  assert.ok(m.endsWith('7890'));
  assert.ok(!m.includes('34567890abcdef123456'));
});

test('isIpAllowed：空列表不限制', () => {
  assert.equal(isIpAllowed('1.2.3.4', []), true);
  assert.equal(isIpAllowed('1.2.3.4', null), true);
});

test('isIpAllowed：精确匹配与通配', () => {
  assert.equal(isIpAllowed('127.0.0.1', ['127.0.0.1']), true);
  assert.equal(isIpAllowed('127.0.0.2', ['127.0.0.1']), false);
  assert.equal(isIpAllowed('8.8.8.8', ['*']), true);
  assert.equal(isIpAllowed('localhost', ['localhost']), true);
});

test('isIpAllowed：IPv4 CIDR 网段', () => {
  assert.equal(isIpAllowed('192.168.1.55', ['192.168.1.0/24']), true);
  assert.equal(isIpAllowed('192.168.2.55', ['192.168.1.0/24']), false);
  assert.equal(isIpAllowed('10.1.2.3', ['10.0.0.0/8']), true);
  assert.equal(isIpAllowed('11.1.2.3', ['10.0.0.0/8']), false);
  // /0 匹配全部
  assert.equal(isIpAllowed('1.2.3.4', ['0.0.0.0/0']), true);
});

test('isIpAllowed：IPv6 回环与映射地址归一化', () => {
  assert.equal(isIpAllowed('::1', ['127.0.0.1']), true);
  assert.equal(isIpAllowed('::ffff:127.0.0.1', ['127.0.0.1']), true);
});

test('scopeAllows：空列表表示不限制', () => {
  assert.equal(scopeAllows([], 'any-model'), true);
  assert.equal(scopeAllows(undefined, 'any-model'), true);
});

test('scopeAllows：精确、通配与前缀通配', () => {
  assert.equal(scopeAllows(['glm-5.3'], 'glm-5.3'), true);
  assert.equal(scopeAllows(['glm-5.3'], 'glm-5.2'), false);
  assert.equal(scopeAllows(['*'], 'whatever'), true);
  assert.equal(scopeAllows(['deepseek*'], 'deepseek-v4.1-flash'), true);
  assert.equal(scopeAllows(['deepseek*'], 'glm-5.3'), false);
  assert.equal(scopeAllows(['intl-cli'], 'cn-cli'), false);
});

test('checkRate：RPM 限流（首次放行、耗尽后 429）', () => {
  const keyId = 'test-rpm-' + Date.now();
  const r1 = checkRate({ keyId, rpm: 2 });
  assert.equal(r1.ok, true);
  const r2 = checkRate({ keyId, rpm: 2 });
  assert.equal(r2.ok, true);
  const r3 = checkRate({ keyId, rpm: 2 });
  assert.equal(r3.ok, false);
  assert.equal(r3.status, 429);
  assert.equal(r3.code, 'rate_limited');
});

test('checkRate：rpm=0 表示不限流', () => {
  const keyId = 'test-nolimit-' + Date.now();
  for (let i = 0; i < 50; i++) assert.equal(checkRate({ keyId, rpm: 0 }).ok, true);
});

test('checkRate：每日调用配额', () => {
  const keyId = 'test-daily-' + Date.now();
  acquireSlot(keyId);
  acquireSlot(keyId);
  const r = checkRate({ keyId, dailyCalls: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'daily_calls_exceeded');
});

test('checkRate：每日 credit 配额', () => {
  const keyId = 'test-credit-' + Date.now();
  const r = checkRate({ keyId, dailyCredit: 10, creditUsedToday: 12 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'daily_credit_exceeded');
});

test('checkRate：并发上限', () => {
  const keyId = 'test-conc-' + Date.now();
  acquireSlot(keyId);
  const r = checkRate({ keyId, concurrency: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'concurrency_limited');
  releaseSlot(keyId);
  assert.equal(checkRate({ keyId, concurrency: 1 }).ok, true);
});

test('resolvePrincipal：主密钥识别为 master 全权', () => {
  const cfg = { apiKey: 'master-key', access: { master: { name: '主密钥' } } };
  const r = resolvePrincipal(cfg, 'master-key');
  assert.equal(r.ok, true);
  assert.equal(r.principal.scope, 'master');
  assert.equal(r.principal.keyId, 'master');
});

test('resolvePrincipal：错误密钥与空密钥被拒', () => {
  const cfg = { apiKey: 'master-key' };
  assert.equal(resolvePrincipal(cfg, 'wrong').ok, false);
  assert.equal(resolvePrincipal(cfg, 'wrong').reason, 'invalid');
  assert.equal(resolvePrincipal(cfg, '').ok, false);
  assert.equal(resolvePrincipal(cfg, '').reason, 'missing');
});

test('authorizeRequest：IP 不在白名单被拒', () => {
  const cfg = { access: { ipAllowList: ['10.0.0.1'] } };
  const principal = { keyId: 'k', scope: 'key', sites: [], models: [], rpm: 0, concurrency: 0, dailyCalls: 0, dailyCredit: 0 };
  const r = authorizeRequest({ cfg, principal, ip: '1.2.3.4', model: 'm', site: 's' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.code, 'ip_not_allowed');
});

test('authorizeRequest：站点/模型越权被拒', () => {
  const cfg = { access: {} };
  const base = { keyId: 'k1', scope: 'key', rpm: 0, concurrency: 0, dailyCalls: 0, dailyCredit: 0 };
  const rSite = authorizeRequest({
    cfg, ip: '127.0.0.1', model: 'm', site: 'cn-cli',
    principal: { ...base, sites: ['intl-cli'], models: [] },
  });
  assert.equal(rSite.ok, false);
  assert.equal(rSite.code, 'site_not_allowed');
  const rModel = authorizeRequest({
    cfg, ip: '127.0.0.1', model: 'glm-5.3', site: 'intl-cli',
    principal: { ...base, sites: [], models: ['deepseek*'] },
  });
  assert.equal(rModel.ok, false);
  assert.equal(rModel.code, 'model_not_allowed');
});

test('authorizeRequest：master 跳过作用域限制', () => {
  const cfg = { access: {} };
  const principal = { keyId: 'master', scope: 'master', sites: [], models: [], rpm: 0, concurrency: 0, dailyCalls: 0, dailyCredit: 0 };
  const r = authorizeRequest({ cfg, principal, ip: '127.0.0.1', model: 'any', site: 'any' });
  assert.equal(r.ok, true);
});