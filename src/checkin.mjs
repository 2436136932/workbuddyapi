// 一键签到 + 成长中心（接口形态参考 88lin/workbuddy-auto-signin，
// 产品形态参考 changexbc/workbuddy-switch；本文件为独立重写）。
// 上游（国内版实测；国际版同构，失败如实返回）：
//   POST {apiBase}/v2/billing/meter/checkin-activity-status  查状态（只读）
//   POST {apiBase}/v2/billing/meter/daily-checkin            领取（幂等）
//   成长中心 base={apiBase}/v2/activity/growth 下的 buddy/travel/*、tasks、streak 等
import crypto from 'node:crypto';
import { getAuth, ensureToken, AuthError } from './auth.mjs';
import { billingHeaders } from './headers.mjs';
import { fetchWithTimeout } from './util.mjs';
import { log, warn } from './log.mjs';

export class CheckinError extends Error {
  constructor(message, { status = 502, site = null, result = 'ERROR' } = {}) {
    super(message);
    this.status = status;
    this.site = site;
    this.result = result;
  }
}

const metaTimeout = (cfg) => cfg.timeouts?.metaMs ?? 20000;

function dig(obj, key) {
  if (obj && typeof obj === 'object') {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
    for (const k of ['data', 'result', 'resp', 'response']) {
      if (obj[k] && typeof obj[k] === 'object') {
        const r = dig(obj[k], key);
        if (r !== undefined && r !== null) return r;
      }
    }
  }
  return undefined;
}

function asInt(v, dflt = 0) {
  const n = Number(v);
  if (Number.isFinite(n)) return Math.trunc(n);
  const f = Number.parseFloat(v);
  if (Number.isFinite(f)) return Math.trunc(f);
  return dflt;
}

function clientToken(prefix = 'u') {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function callUpstream(cfg, site, method, url, { body, retryPost = false } = {}) {
  const siteCfg = cfg.sites[site];
  if (!siteCfg) throw new CheckinError(`未知站点：${site}`, { status: 400, site });
  await ensureToken(cfg, site);
  const auth = getAuth(site);
  const headers = billingHeaders(siteCfg, auth);
  headers['X-Request-ID'] = crypto.randomBytes(16).toString('hex');
  const doOnce = () => fetchWithTimeout(url, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs: metaTimeout(cfg),
  });
  let res;
  try {
    res = await doOnce();
  } catch (e) {
    throw new CheckinError(`[${site}] 签到接口连接失败：${e.message}`, { status: 504, site, result: 'NETWORK' });
  }
  if (retryPost && res.status >= 500) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      res = await doOnce();
    } catch (e) {
      throw new CheckinError(`[${site}] 签到接口连接失败：${e.message}`, { status: 504, site, result: 'NETWORK' });
    }
  }
  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  if (res.status === 401 || res.status === 403) {
    throw new CheckinError(`[${site}] 登录态失效（HTTP ${res.status}），请重新登录该站点`, {
      status: 401, site, result: 'NO_SESSION',
    });
  }
  return { status: res.status, json, text };
}
/** 查询签到状态（只读）。 */
export async function checkinStatus(cfg, site) {
  const siteCfg = cfg.sites[site];
  if (!siteCfg) throw new CheckinError(`未知站点：${site}`, { status: 400, site });
  const { status, json } = await callUpstream(cfg, site, 'POST', siteCfg.apiBase + '/v2/billing/meter/checkin-activity-status', {
    body: {}, retryPost: true,
  });
  if (status < 200 || status >= 300) {
    throw new CheckinError(`[${site}] 签到状态查询失败（HTTP ${status}）：${String(json?.msg || json?.raw || '').slice(0, 160)}`, {
      status: status >= 500 ? 502 : status, site,
    });
  }
  const body = json && typeof json === 'object' ? json : {};
  return {
    http: status,
    active: dig(body, 'active'),
    activityName: dig(body, 'activity_name'),
    todayCheckedIn: dig(body, 'today_checked_in'),
    todayCredit: dig(body, 'today_credit') ?? dig(body, 'daily_credit'),
    streakDays: dig(body, 'streak_days'),
    totalCredits: dig(body, 'total_credits'),
    isStreakDay: dig(body, 'is_streak_day'),
    nextStreakDay: dig(body, 'next_streak_day'),
  };
}

function isAlreadyCheckedIn(body) {
  if (body === null || body === undefined) return true;
  if (typeof body === 'object') {
    if (body.code === 10001) return true;
    if (String(body.msg || '').includes('已签')) return true;
  }
  return false;
}

function alreadyReport(st, via) {
  const inner = [];
  if (st.todayCredit != null) inner.push(`今日 +${st.todayCredit}`);
  if (st.streakDays != null) inner.push(`连续 ${st.streakDays} 天`);
  if (st.totalCredits != null) inner.push(`累计 ${st.totalCredits} 积分`);
  const prefix = via || '今日已签过';
  return inner.length ? `${prefix}（${inner.join('，')}）` : prefix;
}

/** 领取今日签到（幂等：先查状态，未签才领）。 */
export async function claimCheckin(cfg, site) {
  const st = await checkinStatus(cfg, site);
  if (st.active === false) {
    return { site, result: 'INACTIVE', report: `签到活动未开启${st.activityName ? `（${st.activityName}）` : ''}`, status: st };
  }
  if (st.todayCheckedIn === true || st.todayCheckedIn === 1) {
    return { site, result: 'ALREADY', report: alreadyReport(st), status: st };
  }
  const siteCfg = cfg.sites[site];
  const { status, json } = await callUpstream(cfg, site, 'POST', siteCfg.apiBase + '/v2/billing/meter/daily-checkin', {
    body: {}, retryPost: true,
  });
  if (isAlreadyCheckedIn(json)) {
    const fresh = await checkinStatus(cfg, site).catch(() => st);
    return { site, result: 'ALREADY', report: alreadyReport(fresh, '今日已签过（服务端判定已领取）'), status: fresh };
  }
  const credit = dig(json, 'credit');
  if (status >= 200 && status < 300 && credit !== undefined && credit !== null) {
    const fresh = await checkinStatus(cfg, site).catch(() => st);
    const streakDays = fresh.streakDays ?? st.streakDays;
    const total = fresh.totalCredits ?? st.totalCredits;
    const bonus = fresh.isStreakDay ? '，且为连签奖励日' : '';
    const streak = streakDays != null ? `（连续 ${streakDays} 天${total != null ? `，累计 ${total} 积分` : ''}）` : '';
    const report = `成功领取 ${credit} 积分${bonus}${streak}`;
    log(`[${site}] 签到领取成功：${report}`);
    return { site, result: 'CLAIMED', report, credit, streakDays, totalCredits: total, status: fresh };
  }
  const msg = (json && typeof json === 'object' && (json.msg || json.raw)) || `HTTP ${status}`;
  throw new CheckinError(`[${site}] 领取失败：${String(msg).slice(0, 200)}（HTTP ${status}）`, {
    status: status >= 500 ? 502 : 500, site,
  });
}

/** 多站点一键签到：顺序执行，单个站点失败不影响其余。 */
export async function checkinAll(cfg, sites) {
  const targets = (sites?.length ? sites : Object.keys(cfg.sites || {})).filter((s) => cfg.sites[s]?.enabled !== false);
  const results = [];
  for (const site of targets) {
    if (!cfg.sites[site]) {
      results.push({ site, result: 'ERROR', report: `未知站点 ${site}` });
      continue;
    }
    try {
      results.push(await claimCheckin(cfg, site));
    } catch (e) {
      if (e instanceof AuthError) results.push({ site, result: 'NO_SESSION', report: e.message });
      else if (e instanceof CheckinError) results.push({ site, result: e.result || 'ERROR', report: e.message });
      else {
        warn(`[${site}] 签到异常：`, e.message);
        results.push({ site, result: 'ERROR', report: `签到异常：${e.message}` });
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  const claimed = results.filter((r) => r.result === 'CLAIMED').length;
  log(`一键签到完成：${claimed}/${results.length} 个站点领取成功`);
  return { ok: true, count: results.length, claimed, results };
}

/** 多站点签到状态查询（控制台展示用）。 */
export async function checkinStatusAll(cfg, sites) {
  const targets = (sites?.length ? sites : Object.keys(cfg.sites || {})).filter((s) => cfg.sites[s]?.enabled !== false);
  const results = [];
  for (const site of targets) {
    try {
      const st = await checkinStatus(cfg, site);
      const a = getAuth(site);
      results.push({ site, ok: true, ...st, nickname: a.nickname || null, uid: a.uid ? String(a.uid).slice(0, 8) + '…' : null, clone_of: cfg.sites[site]?.cloneOf || null, label: cfg.sites[site]?.label || site });
    } catch (e) {
      results.push({ site, ok: false, error: e.message, label: cfg.sites[site]?.label || site, clone_of: cfg.sites[site]?.cloneOf || null });
    }
  }
  return { ok: true, count: results.length, results };
}

// ---------------- 成长中心（上）：签到 + 旅行 + 任务 ----------------

// ---------------- 成长中心（上）：签到 + 旅行 + 任务 ----------------
export async function runGrowth(cfg, site, { includeCheckin = true } = {}) {
  const siteCfg = cfg.sites[site];
  if (!siteCfg) throw new CheckinError(`未知站点：${site}`, { status: 400, site });
  const base = siteCfg.apiBase + '/v2/activity/growth';
  const parts = [];
  let creditsGained = 0;
  let successes = 0;
  let failures = 0;
  const needAuth = (r) => {
    if (r.status === 401 || r.status === 403) throw new CheckinError(`[${site}] 登录态失效，请重新登录该站点`, { status: 401, site, result: 'NO_SESSION' });
  };
  const get = (p) => callUpstream(cfg, site, 'GET', base + p);
  const post = (p, body) => callUpstream(cfg, site, 'POST', base + p, { body });

  let checkin = null;
  if (includeCheckin) {
    try {
      checkin = await claimCheckin(cfg, site);
      parts.push(checkin.report);
      if (checkin.result === 'CLAIMED') { successes++; creditsGained += asInt(checkin.credit); }
    } catch (e) {
      if (e instanceof CheckinError && e.result === 'NO_SESSION') throw e;
      parts.push(e.message); failures++;
    }
  }

  try {
    const r = await get('/buddy/travel/status');
    needAuth(r);
    if (r.status < 200 || r.status >= 300) parts.push(`查旅行状态失败：HTTP ${r.status}`);
    else {
      let travel = dig(r.json, 'state');
      const dailyLimit = Boolean(dig(r.json, 'daily_limit_reached'));
      if (travel === 'arrived') {
        const c = await post('/buddy/travel/claim', { record_id: dig(r.json, 'record_id') });
        needAuth(c);
        const got = dig(c.json, 'reward_credit');
        if (c.status >= 200 && c.status < 300 && got != null) {
          creditsGained += asInt(got); parts.push(`领旅行礼物 +${got} 积分`); successes++; travel = 'idle';
        } else { parts.push(`领旅行礼物失败：${(c.json && c.json.msg) || 'HTTP ' + c.status}`); failures++; }
      }
      if (travel === 'idle' && dailyLimit) parts.push('今日旅行名额已用完');
      else if (travel === 'idle') {
        const conf = await get('/buddy/travel/config');
        needAuth(conf);
        const locs = dig(conf.json, 'locations');
        if (conf.status >= 200 && conf.status < 300 && Array.isArray(locs) && locs[0]) {
          const d = await post('/buddy/travel/depart', { location_id: locs[0].id });
          needAuth(d);
          if (d.status >= 200 && d.status < 300) { parts.push(`派 Buddy 去${dig(d.json, 'location')?.name || locs[0].name || '?'}`); successes++; }
          else { parts.push(`派 Buddy 失败：${(d.json && d.json.msg) || 'HTTP ' + d.status}`); failures++; }
        }
      } else if (travel === 'traveling') parts.push(`Buddy 旅行中（${dig(r.json, 'location')?.name || '?'}）`);
    }
  } catch (e) {
    if (e instanceof CheckinError && e.result === 'NO_SESSION') throw e;
    parts.push(`旅行模块异常（${e.message}）`); failures++;
  }

  try {
    const r = await get('/tasks');
    needAuth(r);
    if (r.status < 200 || r.status >= 300) parts.push(`查任务列表失败：HTTP ${r.status}`);
    else {
      for (const t of dig(r.json, 'tasks') || []) {
        const st = t.accept_status;
        if (st === 'claimed' || t.locked) continue;
        const prog = t.progress || {};
        const target = asInt(prog.target, 1) || 1;
        const done = asInt(prog.current) >= target;
        if (!done && st) continue;
        const claiming = Boolean(done && st);
        const a = await post('/tasks/accept', { task_code: t.task_code });
        needAuth(a);
        const title = t.title || t.task_code;
        if (a.status >= 200 && a.status < 300) {
          if (claiming) { const rc = dig(a.json, 'credit') ?? t.reward_credit; creditsGained += asInt(rc); parts.push(`领任务奖「${title}」+${asInt(rc)} 积分`); }
          else parts.push(`领取任务「${title}」（进度开始计）`);
          successes++;
        } else { parts.push(`${claiming ? '领任务奖' : '领取任务'}「${title}」失败：${(a.json && a.json.msg) || 'HTTP ' + a.status}`); failures++; }
      }
    }
  } catch (e) {
    if (e instanceof CheckinError && e.result === 'NO_SESSION') throw e;
    parts.push(`任务模块异常（${e.message}）`); failures++;
  }

  // —— 下半场：补登 / 兑换 / 抽奖 / 盲盒 / 展示值 ——
  let streakBody = null;
  let streakStale = false;
  try {
    const r = await get('/streak');
    needAuth(r);
    if (r.status >= 200 && r.status < 300) {
      streakBody = r.json;
      const cardsObj = dig(r.json, 'makeup_cards');
      const cards = (cardsObj && typeof cardsObj === 'object') ? asInt(cardsObj.balance) : asInt(cardsObj);
      const streakObj = dig(r.json, 'streak') || {};
      const dates = streakObj.makeup_dates || dig(r.json, 'makeup_dates') || [];
      if (cards > 0 && Array.isArray(dates) && dates.length) {
        const u = await post('/makeup-cards/use', { target_date: dates[0], client_token: clientToken() });
        needAuth(u);
        if (u.status >= 200 && u.status < 300) { streakStale = true; parts.push(`补登 ${dates[0]}`); successes++; }
        else { parts.push(`补登 ${dates[0]} 失败：${(u.json && u.json.msg) || 'HTTP ' + u.status}`); failures++; }
        if (dates.length > 1) parts.push(`另有 ${dates.length - 1} 天可补，下轮继续`);
      }
    } else parts.push(`查连登状态失败：HTTP ${r.status}`);
  } catch (e) {
    if (e instanceof CheckinError && e.result === 'NO_SESSION') throw e;
    parts.push(`补登模块异常（${e.message}）`); failures++;
  }

  try {
    const r = await get('/redeem/summary');
    needAuth(r);
    if (r.status >= 200 && r.status < 300) {
      for (const [tier, label, days] of [['starter', '入门', 7], ['advanced', '进阶', 14], ['legendary', '巅峰', 28]]) {
        const st = dig(r.json, `${tier}_status`);
        if (!st || st === 'claimed' || st === 'locked') continue;
        let c = await post('/redeem', { tier: days, client_token: clientToken() });
        needAuth(c);
        if (c.status === 400 && String((c.json && c.json.msg) || '').toLowerCase().includes('tier')) {
          c = await post('/redeem', { tier, client_token: clientToken() });
          needAuth(c);
        }
        if (c.status >= 200 && c.status < 300) {
          const got = asInt(dig(c.json, 'credit')); creditsGained += got;
          parts.push(`连登兑换「${label}」${got ? `+${got} 积分` : '奖励已到账'}`); successes++;
        } else { parts.push(`连登兑换「${label}」失败：${(c.json && c.json.msg) || 'HTTP ' + c.status}`); failures++; }
      }
    } else parts.push(`查连登兑换失败：HTTP ${r.status}`);
  } catch (e) {
    if (e instanceof CheckinError && e.result === 'NO_SESSION') throw e;
    parts.push(`连登兑换模块异常（${e.message}）`); failures++;
  }

  try {
    const r = await get('/lottery/chances');
    needAuth(r);
    if (r.status >= 200 && r.status < 300) {
      if (asInt(dig(r.json, 'balance')) > 0) {
        const d = await post('/lottery/draw', { client_token: clientToken() });
        needAuth(d);
        if (d.status >= 200 && d.status < 300) {
          const got = asInt(dig(d.json, 'credit')); creditsGained += got;
          parts.push(`抽奖${got ? ` +${got} 积分` : '完成'}`); successes++;
        } else { parts.push(`抽奖失败：${(d.json && d.json.msg) || 'HTTP ' + d.status}`); failures++; }
      }
    } else parts.push(`查抽奖机会失败：HTTP ${r.status}`);
  } catch (e) {
    if (e instanceof CheckinError && e.result === 'NO_SESSION') throw e;
    parts.push(`抽奖模块异常（${e.message}）`); failures++;
  }

  try {
    const r = await get('/buddy/quota');
    needAuth(r);
    if (r.status >= 200 && r.status < 300) {
      const affordable = asInt(dig(r.json, 'affordable'));
      const maxOpen = asInt(dig(r.json, 'max_open_count'), 1) || 1;
      if (affordable > 0) {
        const count = Math.min(affordable, maxOpen);
        const o = await post('/buddy/open', { count, client_token: clientToken() });
        needAuth(o);
        if (o.status >= 200 && o.status < 300) { parts.push(`开 Buddy 盲盒 ×${count}`); successes++; }
        else { parts.push(`开 Buddy 盲盒失败：${(o.json && o.json.msg) || 'HTTP ' + o.status}`); failures++; }
      }
    } else parts.push(`查 Buddy 能量失败：HTTP ${r.status}`);
  } catch (e) {
    if (e instanceof CheckinError && e.result === 'NO_SESSION') throw e;
    parts.push(`Buddy 盲盒模块异常（${e.message}）`); failures++;
  }

  let energy = null;
  let streakDays = null;
  try {
    const e = await get('/energy').catch(() => null);
    if (e && e.status >= 200 && e.status < 300) energy = dig(e.json, 'balance');
  } catch { /* 纯展示 */ }
  try {
    if (streakBody && !streakStale) streakDays = (dig(streakBody, 'streak') || {}).days ?? null;
    else {
      const s = await get('/streak').catch(() => null);
      if (s && s.status >= 200 && s.status < 300) streakDays = (dig(s.json, 'streak') || {}).days ?? null;
    }
  } catch { /* 纯展示 */ }

  const tail = [];
  if (energy != null) tail.push(`能量 ${energy}`);
  if (streakDays != null) tail.push(`连签 ${streakDays} 天`);
  if (creditsGained) tail.push(`本次 +共 ${creditsGained} 积分`);
  let report = parts.length ? parts.join('；') : (failures ? '成长中心各步骤均失败' : '成长中心无可领取项');
  if (tail.length) report += `（${tail.join('，')}）`;
  const idle = successes === 0 && failures === 0;
  log(`[${site}] 成长中心完成：${report}`);
  return { site, ok: true, clone_of: s?.cloneOf || null, result: 'GROWTH', report, creditsGained, energy, streakDays, idle, checkin, ...(failures ? { failures } : {}) };
}

/** 多站点成长中心（一键签到 + 成长中心全量）。 */
export async function runGrowthAll(cfg, sites, opts = {}) {
  const targets = (sites?.length ? sites : Object.keys(cfg.sites || {})).filter((s) => cfg.sites[s]?.enabled !== false);
  const results = [];
  for (const site of targets) {
    try {
      results.push(await runGrowth(cfg, site, opts));
    } catch (e) {
      if (e instanceof AuthError || (e instanceof CheckinError && e.result === 'NO_SESSION')) {
        results.push({ site, ok: false, result: 'NO_SESSION', report: e.message });
      } else {
        warn(`[${site}] 成长中心异常：`, e.message);
        results.push({ site, ok: false, result: 'ERROR', report: e.message });
      }
    }
  }
  return { ok: true, count: results.length, results };
}

