// 用量与监控统计：按天 / 小时 / 站点 / 模型 / 密钥累计调用次数、token、credit 与延迟分布，
// 落盘 data/usage.json。只在本项目目录内读写；写入做了节流，避免每次请求都打盘。
//
// 统计口径：
//   - calls/errors/tokens/credit：累计值
//   - latency：分位（p50/p90/p95/p99）由有限样本估算，另有直方图桶供 Prometheus 用
//   - hours：24 小时分布（跨天累计，用于看负载时段）
//   - byKey / bySite：按访问密钥与站点拆分
import fs from 'node:fs';
import { paths, ensureDataDir } from './config.mjs';
import { warn } from './log.mjs';

const FILE = paths.usage;
const SAVE_DELAY_MS = 3000;
const MAX_LATENCY_SAMPLES = 2000; // 每模型保留的延迟样本上限（用于分位估算）

// 延迟直方图桶（毫秒），Prometheus 与分位估算共用
export const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000];

let data = emptyData();
let dirty = false;
let timer = null;

function emptyData() {
  return { days: {}, balance: {}, startedAt: new Date().toISOString() };
}

function todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/** 空的一天：按站点 / 模型 / 密钥 / 小时分桶。 */
function emptyDay() {
  return {
    calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, credit: 0, ms: 0,
    models: {}, sites: {}, keys: {}, hours: new Array(24).fill(0),
    latency: { buckets: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0), sum: 0, count: 0, max: 0 },
  };
}

function load() {
  try {
    if (fs.existsSync(FILE)) data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    warn('usage.json 读取失败，重新开始统计：', e.message);
    data = emptyData();
  }
  if (!data.days) data.days = {};
  if (!data.balance) data.balance = {};
  if (!data.startedAt) data.startedAt = new Date().toISOString();
}
load();

function saveNow() {
  dirty = false;
  try {
    ensureDataDir();
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (e) {
    warn('usage.json 写入失败：', e.message);
  }
}

function scheduleSave() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    if (dirty) saveNow();
  }, SAVE_DELAY_MS);
  timer.unref?.();
}

export function flushUsage() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (dirty) saveNow();
}

function dayOf(key = todayKey()) {
  if (!data.days[key]) data.days[key] = emptyDay();
  const d = data.days[key];
  // 兼容旧版数据结构（缺新字段时补齐）
  if (!d.models) d.models = {};
  if (!d.sites) d.sites = {};
  if (!d.keys) d.keys = {};
  if (!Array.isArray(d.hours)) d.hours = new Array(24).fill(0);
  if (!d.latency) d.latency = { buckets: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0), sum: 0, count: 0, max: 0 };
  if (!Array.isArray(d.latency.buckets) || d.latency.buckets.length !== LATENCY_BUCKETS_MS.length + 1) {
    d.latency.buckets = new Array(LATENCY_BUCKETS_MS.length + 1).fill(0);
  }
  return d;
}

/** 把一次耗时计入直方图桶。 */
function observeLatency(lat, ms) {
  lat.sum += ms;
  lat.count += 1;
  if (ms > lat.max) lat.max = ms;
  let i = 0;
  while (i < LATENCY_BUCKETS_MS.length && ms > LATENCY_BUCKETS_MS[i]) i++;
  lat.buckets[i] += 1;
}

function bumpAgg(bucket, { errors = 0, promptTokens = 0, completionTokens = 0, credit = 0, ms = 0, tools = 0, realModel = null, model = null, site = null }) {
  bucket.calls += 1;
  bucket.errors += errors;
  bucket.promptTokens += promptTokens;
  bucket.completionTokens += completionTokens;
  bucket.credit += credit;
  bucket.ms += ms;
  if (tools) bucket.tools = (bucket.tools || 0) + tools;
  if (realModel && !bucket.real) bucket.real = realModel;
  if (model && !bucket.model) bucket.model = model;
  if (site && !bucket.site) bucket.site = site;
  return bucket;
}

/** 记录一次调用（含被拒绝的请求：status 非 2xx/3xx 计为失败）。 */
export function recordUsage({
  site, model, mode, status, promptTokens = 0, completionTokens = 0, credit = 0,
  ms = 0, tools = 0, realModel = null, keyId = null, keyName = null,
}) {
  const day = dayOf();
  const ok = status >= 200 && status < 400;
  // 上游字段可能是字符串数值（如 credit="0.06"），统一强转成数字，避免累加时退化为字符串拼接。
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const pt = num(promptTokens);
  const ct = num(completionTokens);
  const cr = num(credit);
  const cost = num(ms);
  const tl = num(tools);

  day.calls += 1;
  if (!ok) day.errors += 1;
  day.promptTokens += pt;
  day.completionTokens += ct;
  day.credit += cr;
  day.ms += cost;
  day.hours[new Date().getHours()] += 1;
  observeLatency(day.latency, cost);

  const key = `${site}/${model}`;
  if (!day.models[key]) {
    day.models[key] = {
      site, model, real: null, calls: 0, errors: 0, promptTokens: 0,
      completionTokens: 0, credit: 0, ms: 0, tools: 0, samples: [],
      latency: { buckets: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0), sum: 0, count: 0, max: 0 },
    };
  }
  const m = day.models[key];
  bumpAgg(m, { promptTokens: pt, completionTokens: ct, credit: cr, ms: cost, tools: tl, realModel, model, site, errors: ok ? 0 : 1 });
  observeLatency(m.latency, cost);
  // 保留有限样本，用于 p50/p90/p95/p99 精确估算
  m.samples.push(cost);
  if (m.samples.length > MAX_LATENCY_SAMPLES) m.samples.splice(0, m.samples.length - MAX_LATENCY_SAMPLES);

  const sk = site || 'unknown';
  if (!day.sites[sk]) day.sites[sk] = { site: sk, calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, credit: 0, ms: 0, tools: 0, models: {} };
  bumpAgg(day.sites[sk], { promptTokens: pt, completionTokens: ct, credit: cr, ms: cost, tools: tl, errors: ok ? 0 : 1 });
  day.sites[sk].models[model] = (day.sites[sk].models[model] || 0) + 1;

  if (keyId) {
    if (!day.keys[keyId]) day.keys[keyId] = { keyId, name: keyName || keyId, calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, credit: 0, ms: 0, tools: 0 };
    bumpAgg(day.keys[keyId], { promptTokens: pt, completionTokens: ct, credit: cr, ms: cost, tools: tl, errors: ok ? 0 : 1 });
    if (keyName) day.keys[keyId].name = keyName;
  }
  scheduleSave();
}

/** 记录一次余额快照（用于画余额趋势）。 */
export function recordBalance(site, remain) {
  if (typeof remain !== 'number') return;
  const list = data.balance[site] || (data.balance[site] = []);
  const last = list[list.length - 1];
  const now = Date.now();
  if (last && last.v === remain) return; // 没变化就不记
  if (last && now - last.t < 60_000 && last.v === remain) return;
  list.push({ t: now, v: remain });
  if (list.length > 500) list.splice(0, list.length - 500);
  scheduleSave();
}

/** 从延迟样本算分位（p 为 0–1）。样本不足时返回 null。 */
function percentile(samples, p) {
  if (!samples?.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/** 汇总：今天 / 最近 N 天 / 按模型排行 / 按站点 / 按密钥 / 小时分布 / 余额趋势。 */
export function usageSnapshot(days = 7) {
  const today = todayKey();
  const t = data.days[today] || emptyDay();
  const keys = Object.keys(data.days).sort().slice(-days);
  const recent = keys.map((k) => {
    const d = data.days[k];
    return { date: k, calls: d.calls, errors: d.errors, promptTokens: d.promptTokens, completionTokens: d.completionTokens, credit: d.credit, ms: d.ms || 0 };
  });
  const totals = { calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, credit: 0, ms: 0 };
  const byModel = new Map();
  const bySite = new Map();
  const byKey = new Map();
  const hours = new Array(24).fill(0);
  const latencySamples = [];
  const latencyAgg = { buckets: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0), sum: 0, count: 0, max: 0 };

  for (const k of Object.keys(data.days)) {
    const d = data.days[k];
    totals.calls += d.calls;
    totals.errors += d.errors;
    totals.promptTokens += d.promptTokens;
    totals.completionTokens += d.completionTokens;
    totals.credit += d.credit;
    totals.ms += d.ms || 0;
    for (let h = 0; h < 24; h++) hours[h] += d.hours?.[h] || 0;
    if (d.latency) {
      latencyAgg.sum += d.latency.sum || 0;
      latencyAgg.count += d.latency.count || 0;
      latencyAgg.max = Math.max(latencyAgg.max, d.latency.max || 0);
      (d.latency.buckets || []).forEach((v, i) => { latencyAgg.buckets[i] += v || 0; });
    }
    for (const [mid, m] of Object.entries(d.models || {})) {
      const cur = byModel.get(mid) || {
        id: mid, site: m.site, model: m.model, real: null, calls: 0, errors: 0,
        promptTokens: 0, completionTokens: 0, credit: 0, ms: 0, tools: 0, samples: [],
      };
      cur.calls += m.calls;
      cur.errors += m.errors;
      cur.promptTokens += m.promptTokens;
      cur.completionTokens += m.completionTokens;
      cur.credit += m.credit;
      cur.ms += m.ms || 0;
      cur.tools += m.tools || 0;
      if (m.real) cur.real = m.real;
      if (m.samples?.length) cur.samples.push(...m.samples);
      byModel.set(mid, cur);
    }
    for (const [sk, s] of Object.entries(d.sites || {})) {
      const cur = bySite.get(sk) || { site: sk, calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, credit: 0, ms: 0, models: {} };
      cur.calls += s.calls; cur.errors += s.errors;
      cur.promptTokens += s.promptTokens; cur.completionTokens += s.completionTokens;
      cur.credit += s.credit; cur.ms += s.ms || 0;
      for (const [mid, n] of Object.entries(s.models || {})) cur.models[mid] = (cur.models[mid] || 0) + n;
      bySite.set(sk, cur);
    }
    for (const [kk, s] of Object.entries(d.keys || {})) {
      const cur = byKey.get(kk) || { keyId: kk, name: s.name, calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, credit: 0, ms: 0 };
      cur.calls += s.calls; cur.errors += s.errors;
      cur.promptTokens += s.promptTokens; cur.completionTokens += s.completionTokens;
      cur.credit += s.credit; cur.ms += s.ms || 0;
      if (s.name) cur.name = s.name;
      byKey.set(kk, cur);
    }
  }

  const modelList = [...byModel.values()].map((m) => {
    const samples = m.samples?.length ? m.samples : [];
    latencySamples.push(...samples);
    const { samples: _drop, ...rest } = m;
    return {
      ...rest,
      avgMs: rest.calls ? Math.round(rest.ms / rest.calls) : 0,
      p50Ms: percentile(samples, 0.5),
      p90Ms: percentile(samples, 0.9),
      p95Ms: percentile(samples, 0.95),
      p99Ms: percentile(samples, 0.99),
    };
  });

  const totalLatency = {
    avgMs: latencyAgg.count ? Math.round(latencyAgg.sum / latencyAgg.count) : 0,
    maxMs: latencyAgg.max || 0,
    p50Ms: percentile(latencySamples, 0.5),
    p90Ms: percentile(latencySamples, 0.9),
    p95Ms: percentile(latencySamples, 0.95),
    p99Ms: percentile(latencySamples, 0.99),
  };

  return {
    today: { date: today, ...t, models: undefined },
    todayByModel: Object.values(t.models || {}).sort((a, b) => b.calls - a.calls),
    recent,
    totals,
    totalLatency,
    latencyBucketsMs: LATENCY_BUCKETS_MS,
    latencyBuckets: latencyAgg.buckets,
    byModel: modelList.sort((a, b) => b.credit - a.credit || b.calls - a.calls),
    bySite: [...bySite.values()].sort((a, b) => b.calls - a.calls),
    byKey: [...byKey.values()].sort((a, b) => b.calls - a.calls),
    hours,
    balance: data.balance,
    since: Object.keys(data.days).sort()[0] || today,
    startedAt: data.startedAt,
  };
}

/** 按天明细（导出 CSV 用）。 */
export function dailyRows() {
  return Object.keys(data.days).sort().map((date) => {
    const d = data.days[date];
    return {
      date, calls: d.calls, errors: d.errors,
      promptTokens: d.promptTokens, completionTokens: d.completionTokens,
      credit: d.credit, avgMs: d.calls ? Math.round((d.ms || 0) / d.calls) : 0,
    };
  });
}

export function resetUsage() {
  data = emptyData();
  dirty = true;
  saveNow();
}