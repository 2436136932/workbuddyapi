// 积分（credit）组成与到期时间：把上游额度接口返回的每个套餐条目规范化，
// 汇总出「总额度由哪几部分组成」「每部分什么时候到期」。
//
// 上游字段口径（实测 cn-cli / intl-cli）：
//   PackageName        套餐名，如「CodeBuddy个人体验版」「Bonus Pack」「国内运营裂变包」
//   CapacityType       4 = 周期性订阅/体验版（每月重置）；1 = 一次性赠送包（用完即止）
//   CapacitySize       该包总量；CapacityRemain 剩余；CapacityUsed 已用
//   CycleCapacity*     本周期口径（周期性套餐按月重置时用它）
//   CycleStartTime/EndTime   本计费周期起止（字符串，UTC）
//   DeductionStartTime/EndTime  该包真正可用/失效的时刻（epoch 毫秒）——「彻底到期」看这个
//   ExpiredTime        上游标注的失效时间（可能为空）
//   Status             0 = 有效；3 = 已失效/已耗尽

const TYPE_LABEL = {
  1: '一次性赠送',
  2: '包年包月',
  3: '按量付费',
  4: '周期订阅',
};

/** 把上游时间字段（epoch 毫秒 / "YYYY-MM-DD HH:mm:ss" / ISO / 空）统一成 ISO 字符串。 */
export function toIso(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = String(v).trim();
  if (!s) return null;
  // 上游形如 "2026-10-31 23:59:59"，按 UTC 解释
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * 规范化单个套餐条目。
 * remain 口径与上游计费一致：周期性套餐看本周期剩余，其余看总剩余。
 */
export function normalizePackage(a) {
  const cycleSize = num(a.CycleCapacitySize);
  const periodic = num(a.CapacityType) === 4 || cycleSize > 0;
  const remain = periodic && cycleSize > 0 ? num(a.CycleCapacityRemain) : num(a.CapacityRemain);
  const used = periodic && cycleSize > 0
    ? num(a.CycleCapacityUsed ?? (cycleSize - num(a.CycleCapacityRemain)))
    : num(a.CapacityUsed ?? (num(a.CapacitySize) - num(a.CapacityRemain)));
  const size = periodic && cycleSize > 0 ? cycleSize : num(a.CapacitySize);

  return {
    package: a.PackageName || '未命名套餐',
    subProduct: a.SubProductName || null,
    type: num(a.CapacityType) || null,
    typeLabel: TYPE_LABEL[num(a.CapacityType)] || `类型${a.CapacityType ?? '?'}`,
    unit: a.CapacityUnit || 'credits',
    periodic,
    size,
    remain,
    used,
    totalSize: num(a.CapacitySize),
    totalRemain: num(a.CapacityRemain),
    // 周期起止（周期性套餐每月重置）
    cycleStart: toIso(a.CycleStartTime),
    cycleEnd: toIso(a.CycleEndTime),
    // 真正失效时刻（一次性的截止时间看这里）
    deductionStart: toIso(a.DeductionStartTime),
    deductionEnd: toIso(a.DeductionEndTime),
    expiredTime: toIso(a.ExpiredTime),
    status: a.Status ?? null,
    active: num(a.Status) === 0,
    remainCycles: a.RemainCycles ?? null,
    totalCycles: a.TotalCycles ?? null,
  };
}

/** 判定一个套餐的「有效到期时间」：优先 DeductionEndTime，其次 ExpiredTime，再其次 CycleEndTime。 */
export function effectiveExpiry(p) {
  return p.deductionEnd || p.expiredTime || p.cycleEnd || null;
}

/**
 * 汇总额度：总额、剩余、各组成部分、最近到期时间。
 * @param {object[]} rawAccounts 上游 Accounts 数组
 * @param {object} [opts] { now: Date, includeInactive: boolean }
 */
export function summarizeCredit(rawAccounts, { now = new Date(), includeInactive = false } = {}) {
  const all = (Array.isArray(rawAccounts) ? rawAccounts : []).map(normalizePackage);
  // 默认只看仍然有效的包（status=0）；失效包用于历史展示
  const packages = includeInactive ? all : all.filter((p) => p.active);
  const inactive = all.filter((p) => !p.active);

  let remain = 0;
  let size = 0;
  let used = 0;
  for (const p of packages) {
    remain += p.remain;
    size += p.size;
    used += p.used;
  }

  // 按套餐名聚合（同名多个包合并，这是「积分组成」的主视图）
  const byName = new Map();
  for (const p of packages) {
    const key = p.package;
    const cur = byName.get(key) || {
      package: key,
      typeLabel: p.typeLabel,
      type: p.type,
      unit: p.unit,
      periodic: p.periodic,
      count: 0,
      size: 0,
      remain: 0,
      used: 0,
      earliestExpiry: null,
      latestExpiry: null,
    };
    cur.count += 1;
    cur.size += p.size;
    cur.remain += p.remain;
    cur.used += p.used;
    const exp = effectiveExpiry(p);
    if (exp) {
      if (!cur.earliestExpiry || exp < cur.earliestExpiry) cur.earliestExpiry = exp;
      if (!cur.latestExpiry || exp > cur.latestExpiry) cur.latestExpiry = exp;
    }
    byName.set(key, cur);
  }

  const parts = [...byName.values()].map((c) => ({
    ...c,
    share: remain > 0 ? c.remain / remain : 0,
  })).sort((a, b) => b.remain - a.remain || b.size - a.size);

  // 各组成部分按「到期时间」排序，找出最近要过期的（提醒用）
  const expiring = packages
    .filter((p) => p.remain > 0)
    .map((p) => ({ ...p, expiry: effectiveExpiry(p) }))
    .filter((p) => p.expiry)
    .sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0));

  const nextExpiry = expiring.length ? expiring[0] : null;
  const daysLeft = nextExpiry
    ? Math.ceil((new Date(nextExpiry.expiry).getTime() - now.getTime()) / 86400000)
    : null;

  return {
    remain: round(remain),
    size: round(size),
    used: round(used),
    unit: packages[0]?.unit || 'credits',
    packageCount: packages.length,
    inactiveCount: inactive.length,
    // 积分组成
    parts,
    // 各包明细（含截止/到期时间）
    packages: packages.map((p) => ({ ...p, expiry: effectiveExpiry(p) })),
    inactive: includeInactive ? inactive.map((p) => ({ ...p, expiry: effectiveExpiry(p) })) : undefined,
    // 到期提醒：最近一个还有余额且会过期的包
    nextExpiry: nextExpiry
      ? { package: nextExpiry.package, expiry: nextExpiry.expiry, remain: round(nextExpiry.remain), daysLeft }
      : null,
    // 彻底失效时间（所有有效包中最晚的截止时间，通常订阅类在多年后）
    lastExpiry: expiring.length ? expiring[expiring.length - 1].expiry : null,
    updatedAt: now.toISOString(),
  };
}

function round(n) {
  return Math.round(num(n) * 1000) / 1000;
}

/**
 * 人类可读的剩余时间描述（控制台与 CLI 共用）。
 * 不足 1 天按小时/分钟显示；1 天以上向上取整，与徽章的「N 天后」口径一致。
 */
export function humanizeUntil(iso, now = new Date()) {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - now.getTime();
  if (Number.isNaN(ms)) return '—';
  if (ms <= 0) return '已过期';
  if (ms < 86400000) {
    const h = Math.floor(ms / 3600000);
    if (h >= 1) return `${h} 小时`;
    return `${Math.max(1, Math.floor(ms / 60000))} 分钟`;
  }
  const d = Math.ceil(ms / 86400000);
  if (d >= 365) return `${Math.floor(d / 365)} 年 ${d % 365} 天`;
  return `${d} 天`;
}