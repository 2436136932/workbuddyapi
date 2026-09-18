import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoCheckinStatus, setAutoCheckin, recordCheckinRun } from '../src/auto-checkin.mjs';

// 注意：这些测试会读写项目内的 checkin.json（gitignore 已忽略），跑完恢复原状。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.mjs';
const FILE = path.join(ROOT, 'checkin.json');
const backup = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : null;

test('自动签到开关读写', () => {
  const s = setAutoCheckin({ enabled: true, hour: 8, minute: 30 });
  assert.equal(s.enabled, true);
  assert.equal(s.hour, 8);
  assert.equal(s.minute, 30);
  const q = autoCheckinStatus();
  assert.equal(q.enabled, true);
  setAutoCheckin({ enabled: false });
  assert.equal(autoCheckinStatus().enabled, false);
});

test('签到记录写入 lastRun', () => {
  recordCheckinRun({ claimed: 1, count: 2, results: [{ site: 'cn-cli', result: 'CLAIMED', report: 'ok' }] }, { trigger: 'manual' });
  const q = autoCheckinStatus();
  assert.ok(q.lastRun);
  assert.equal(q.lastRun.trigger, 'manual');
  assert.equal(q.lastRun.claimed, 1);
  if (backup === null) fs.rmSync(FILE, { force: true });
  else fs.writeFileSync(FILE, backup, 'utf8');
});
