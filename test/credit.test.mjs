import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toIso, normalizePackage, effectiveExpiry, summarizeCredit, humanizeUntil } from '../src/credit.mjs';

// 上游实测返回的两种典型条目
const periodic = {
  PackageName: 'CodeBuddy个人体验版',
  SubProductName: '腾讯云代码助手 (IDE)',
  CapacityType: 4,
  CapacityUnit: 'credits',
  CapacitySize: 500,
  CapacityRemain: 500,
  CapacityUsed: 0,
  CycleCapacitySize: 500,
  CycleCapacityRemain: 500,
  CycleStartTime: '2026-10-01 00:00:00',
  CycleEndTime: '2026-10-31 23:59:59',
  DeductionStartTime: 1789090110000,
  DeductionEndTime: 2049413309000,
  ExpiredTime: '',
  Status: 0,
};

const bonus = {
  PackageName: 'Bonus Pack',
  CapacityType: 1,
  CapacityUnit: 'credit',
  CapacitySize: 30,
  CapacityRemain: 22,
  CapacityUsed: 7,
  CycleCapacitySize: 30,
  CycleCapacityRemain: 22,
  CycleCapacityUsed: 7,
  CycleEndTime: '2026-10-12 01:15:49',
  DeductionEndTime: 1791738949000,
  Status: 0,
};

const expired = {
  PackageName: '旧包',
  CapacityType: 1,
  CapacitySize: 100,
  CapacityRemain: 0,
  CapacityUsed: 100,
  CycleEndTime: '2026-10-12 01:15:49',
  DeductionEndTime: 1791738949000,
  ExpiredTime: '2026-10-05 00:00:00',
  Status: 3,
};

test('toIso：epoch 毫秒 / 上游时间串 / ISO / 空值', () => {
  assert.equal(toIso(0), '1970-01-01T00:00:00.000Z');
  assert.equal(toIso('2026-10-31 23:59:59'), '2026-10-31T23:59:59.000Z');
  assert.equal(toIso('2026-10-31T23:59:59Z'), '2026-10-31T23:59:59.000Z');
  assert.equal(toIso(''), null);
  assert.equal(toIso(null), null);
  assert.equal(toIso(undefined), null);
  assert.equal(toIso('not-a-date'), null);
});

test('normalizePackage：周期性套餐用本周期口径', () => {
  const p = normalizePackage(periodic);
  assert.equal(p.package, 'CodeBuddy个人体验版');
  assert.equal(p.periodic, true);
  assert.equal(p.typeLabel, '周期订阅');
  assert.equal(p.remain, 500);
  assert.equal(p.size, 500);
  assert.equal(p.used, 0);
  assert.equal(p.active, true);
  assert.equal(p.cycleEnd, '2026-10-31T23:59:59.000Z');
});

test('normalizePackage：一次性赠送包按总量口径', () => {
  const p = normalizePackage(bonus);
  assert.equal(p.package, 'Bonus Pack');
  assert.equal(p.typeLabel, '一次性赠送');
  assert.equal(p.remain, 22);
  assert.equal(p.used, 7);
  assert.equal(p.size, 30);
});

test('normalizePackage：已失效包标记 active=false', () => {
  const p = normalizePackage(expired);
  assert.equal(p.active, false);
  assert.equal(p.status, 3);
});

test('effectiveExpiry：优先扣减截止时间', () => {
  const p = normalizePackage(bonus);
  // DeductionEndTime 存在时以它为准（真正的失效时刻）
  assert.equal(effectiveExpiry(p), p.deductionEnd);
  // 无扣减时间时退回 ExpiredTime
  const noDeduct = normalizePackage({ ...bonus, DeductionEndTime: undefined });
  assert.equal(effectiveExpiry(noDeduct), noDeduct.cycleEnd);
});

test('summarizeCredit：汇总剩余 / 组成 / 到期（默认只看有效包）', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  const s = summarizeCredit([periodic, bonus, expired], { now });
  assert.equal(s.remain, 522); // 500 + 22（失效包不计）
  assert.equal(s.used, 7);
  assert.equal(s.packageCount, 2);
  assert.equal(s.inactiveCount, 1);
  assert.equal(s.parts.length, 2);
  // 组成按剩余量降序
  assert.equal(s.parts[0].package, 'CodeBuddy个人体验版');
  assert.equal(s.parts[0].remain, 500);
  assert.equal(s.parts[1].package, 'Bonus Pack');
  // 占比之和为 1
  const shareSum = s.parts.reduce((n, p) => n + p.share, 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-9, `占比之和应为 1，实际 ${shareSum}`);
});

test('summarizeCredit：includeInactive 时包含失效包', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  const s = summarizeCredit([periodic, expired], { now, includeInactive: true });
  assert.equal(s.packages.length, 2);
  assert.equal(s.inactive.length, 1);
});

test('summarizeCredit：nextExpiry 指向最近到期且有余额的包', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  const s = summarizeCredit([periodic, bonus], { now });
  assert.ok(s.nextExpiry);
  // bonus 的扣减截止（2026-10-11）早于 periodic（2034）
  assert.equal(s.nextExpiry.package, 'Bonus Pack');
  assert.equal(s.nextExpiry.remain, 22);
  assert.ok(s.nextExpiry.daysLeft >= 0);
});

test('summarizeCredit：空输入不炸', () => {
  const s = summarizeCredit([], { now: new Date() });
  assert.equal(s.remain, 0);
  assert.equal(s.packageCount, 0);
  assert.deepEqual(s.parts, []);
  assert.equal(s.nextExpiry, null);
  assert.equal(s.lastExpiry, null);
});

test('summarizeCredit：同名包聚合为一个组成部分', () => {
  const a = { ...bonus, CapacityRemain: 10, CycleCapacityRemain: 10 };
  const b = { ...bonus, CapacityRemain: 20, CycleCapacityRemain: 20 };
  const s = summarizeCredit([a, b], { now: new Date('2026-10-10T00:00:00Z') });
  assert.equal(s.parts.length, 1);
  assert.equal(s.parts[0].count, 2);
  assert.equal(s.parts[0].remain, 30);
});

test('humanizeUntil：向上取整并与徽章口径一致', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  // 3.5 天 → 4 天（与「N 天后」徽章一致）
  assert.equal(humanizeUntil('2026-10-13T12:00:00Z', now), '4 天');
  assert.equal(humanizeUntil('2026-10-11T00:00:00Z', now), '1 天');
  assert.equal(humanizeUntil('2026-10-10T05:00:00Z', now), '5 小时');
  assert.equal(humanizeUntil('2026-10-09T00:00:00Z', now), '已过期');
  assert.equal(humanizeUntil(null, now), '—');
  assert.equal(humanizeUntil('bad', now), '—');
});