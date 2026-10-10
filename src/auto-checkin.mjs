// 一键签到（参考 workbuddy-switch 的产品形态：状态查询 + 一键领取 + 自动签到；
// 上游接口形态参考 88lin/workbuddy-auto-signin，本文件为独立重写）。
// 状态落盘 data/checkin.json（含各站点最近一次签到结果 + 自动签到开关），已被 .gitignore 忽略。
import fs from 'node:fs';
import { paths, ensureDataDir } from './config.mjs';
import { checkinAll } from './checkin.mjs';
import { log } from './log.mjs';

const FILE = paths.checkin;

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { auto: false, hour: 9, minute: 10, sites: null, lastRun: null, history: [] };
  }
}

function save(s) {
  try {
    ensureDataDir();
    fs.writeFileSync(FILE, JSON.stringify(s, null, 2) + '\n', 'utf8');
  } catch { /* 落盘失败不影响主流程 */ }
}

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 自动签到当前状态（控制台展示用）。 */
export function autoCheckinStatus() {
  const s = load();
  return {
    enabled: Boolean(s.auto),
    hour: s.hour ?? 9,
    minute: s.minute ?? 10,
    sites: s.sites || null,
    lastRun: s.lastRun || null,
    todayDone: (s.lastRun?.day === todayKey()) && (s.lastRun?.claimed || 0) > 0,
  };
}

/** 开关自动签到。 */
export function setAutoCheckin({ enabled, hour, minute, sites }) {
  const s = load();
  if (enabled !== undefined) s.auto = Boolean(enabled);
  if (hour !== undefined) s.hour = Math.min(23, Math.max(0, Number(hour) || 0));
  if (minute !== undefined) s.minute = Math.min(59, Math.max(0, Number(minute) || 0));
  if (sites !== undefined) s.sites = sites;
  save(s);
  log(`自动签到${s.auto ? `已开启（每天 ${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}）` : '已关闭'}`);
  return autoCheckinStatus();
}

/** 记录一次签到结果（含自动/手动）。 */
export function recordCheckinRun(result, { trigger = 'manual' } = {}) {
  const s = load();
  const entry = {
    at: new Date().toISOString(),
    day: todayKey(),
    trigger,
    claimed: result.claimed ?? 0,
    count: result.count ?? 0,
    results: (result.results || []).map((r) => ({ site: r.site, result: r.result, report: r.report })),
  };
  s.lastRun = entry;
  s.history = [entry, ...(s.history || [])].slice(0, 30);
  save(s);
  return entry;
}

function dueToday(s, now = new Date()) {
  const hh = s.hour ?? 9;
  const mm = s.minute ?? 10;
  const mins = (d) => d.getHours() * 60 + d.getMinutes();
  if (mins(now) < hh * 60 + mm) return false;
  return s.lastRun?.day !== todayKey(now);
}

/** 服务内定时器每分钟调用：到点且今天没跑过 → 跑一轮。 */
export async function maybeAutoCheckin(cfg) {
  const s = load();
  if (!s.auto) return null;
  if (!dueToday(s)) return null;
  log('自动签到触发（到点且今日未签），开始执行…');
  try {
    const r = await checkinAll(cfg, s.sites);
    recordCheckinRun(r, { trigger: 'auto' });
    return r;
  } catch (e) {
    log('自动签到异常：' + e.message);
    return null;
  }
}
