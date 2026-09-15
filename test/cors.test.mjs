import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCorsOrigin } from '../src/cors.mjs';

const cfg = { host: '127.0.0.1', port: 8788, cors: { allowOrigins: ['https://my.app'] } };
const req = (origin) => ({ headers: origin === undefined ? {} : { origin } });

test('无 Origin 放行（CLI / SDK）', () => {
  assert.equal(resolveCorsOrigin(cfg, req()).allowed, true);
});

test('本机来源放行', () => {
  assert.equal(resolveCorsOrigin(cfg, req('http://127.0.0.1:5000')).allowed, true);
  assert.equal(resolveCorsOrigin(cfg, req('http://localhost:8788')).allowed, true);
  assert.equal(resolveCorsOrigin(cfg, req('http://[::1]:8788')).allowed, true);
});

test('配置自身 host:port 放行', () => {
  assert.equal(resolveCorsOrigin(cfg, req('http://127.0.0.1:8788')).allowed, true);
});

test('白名单放行', () => {
  assert.equal(resolveCorsOrigin(cfg, req('https://my.app')).allowed, true);
});

test('陌生站点拒绝', () => {
  assert.equal(resolveCorsOrigin(cfg, req('https://evil.com')).allowed, false);
  assert.equal(resolveCorsOrigin(cfg, req('http://127.0.0.1.evil.com')).allowed, false);
});

test('Origin: null 放行', () => {
  assert.equal(resolveCorsOrigin(cfg, req('null')).allowed, true);
});

test('自定义 host：自身端口放行、他端口拒绝', () => {
  const c2 = { host: '192.168.1.9', port: 9000, cors: {} };
  assert.equal(resolveCorsOrigin(c2, req('http://192.168.1.9:9000')).allowed, true);
  assert.equal(resolveCorsOrigin(c2, req('http://192.168.1.9:9001')).allowed, false);
});
