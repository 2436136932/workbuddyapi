import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { paths, ROOT, DATA_DIR, authPathFor, resolveDataFile, ensureDataDir, defaultConfig } from '../src/config.mjs';

test('paths：运行时数据统一落在 data/ 目录', () => {
  assert.equal(paths.root, ROOT);
  assert.equal(paths.data, DATA_DIR);
  for (const key of ['config', 'keys', 'usage', 'checkin', 'audit', 'loginState', 'legacyAuth', 'log']) {
    assert.ok(paths[key], `paths.${key} 应存在`);
    assert.ok(
      path.resolve(paths[key]).startsWith(path.resolve(DATA_DIR) + path.sep),
      `paths.${key} 应在 data 目录内：${paths[key]}`,
    );
  }
});

test('paths：data 目录不再等于项目根目录', () => {
  assert.notEqual(path.resolve(DATA_DIR), path.resolve(ROOT));
});

test('authPathFor：凭证按站点分文件且位于 data/', () => {
  const p = authPathFor('cn-cli');
  assert.ok(p.endsWith(`auth.cn-cli.json`));
  assert.ok(path.resolve(p).startsWith(path.resolve(DATA_DIR) + path.sep));
});

test('authPathFor：拒绝路径穿越与非法键', () => {
  for (const bad of ['../evil', 'a/b', 'a\\b', '', 'A B', '.hidden', 'x'.repeat(33)]) {
    assert.throws(() => authPathFor(bad), /非法站点键/, `应拒绝：${bad}`);
  }
});

test('authPathFor：接受合法槽位键', () => {
  for (const good of ['cn-cli', 'cn-2', 'intl-cli-2', 'a', 'site1']) {
    assert.ok(authPathFor(good).endsWith(`auth.${good}.json`));
  }
});

test('resolveDataFile：优先返回 data/ 下的路径', () => {
  const p = resolveDataFile('definitely-missing-file.json');
  assert.equal(path.resolve(p), path.resolve(path.join(DATA_DIR, 'definitely-missing-file.json')));
});

test('ensureDataDir：目录存在且可写（幂等）', () => {
  const d = ensureDataDir();
  assert.equal(path.resolve(d), path.resolve(DATA_DIR));
  assert.equal(ensureDataDir(), d); // 重复调用不报错
});

test('defaultConfig：包含访问控制与监控配置', () => {
  const cfg = defaultConfig();
  assert.ok(cfg.access, '应有 access 配置');
  assert.ok(Array.isArray(cfg.access.ipAllowList));
  assert.equal(typeof cfg.access.audit.enabled, 'boolean');
  assert.ok(cfg.metrics, '应有 metrics 配置');
  assert.equal(typeof cfg.metrics.enabled, 'boolean');
  assert.ok(Array.isArray(cfg.metrics.latencyBucketsMs));
  assert.ok(cfg.metrics.latencyBucketsMs.length > 0);
  assert.ok(cfg.access.master, '应有主密钥策略');
});

test('defaultConfig：站点表含内置三站且可克隆', () => {
  const cfg = defaultConfig();
  assert.ok(cfg.sites['cn-cli']);
  assert.ok(cfg.sites['intl-cli']);
  assert.ok(cfg.sites['intl-work']);
  assert.equal(cfg.sites['cn-cli'].enabled, true);
});