// 控制台后端 API：状态总览 / 模型清单 / 一键切换默认模型 / 一键签到 / 日志 / 用量 / 探测 / 登录 / 停服
// 仅本机可用（服务只监听 127.0.0.1），鉴权用控制台会话 token 或 config.json 的 apiKey。
import { siteKeys, saveConfig, siteGroups, slotGroupOf, cloneSiteSlot, removeSiteSlot } from './config.mjs';
import { getAuth, isLoggedIn } from './auth.mjs';
import { getCatalog, mergedModels, parseMultiplier, clearCatalog } from './router.mjs';
import { queryCredit, openChat, classifyFrame, upstreamErrorMessage } from './upstream.mjs';
import { checkinStatusAll, checkinAll, runGrowthAll, CheckinError } from './checkin.mjs';
import { autoCheckinStatus, setAutoCheckin } from './auto-checkin.mjs';
import { startLogin, pollLogin } from './device-login.mjs';
import { usageSnapshot, resetUsage, flushUsage, recordBalance } from './usage.mjs';
import { recentLogs } from './log.mjs';
import { sendJson } from './util.mjs';

const startedAt = Date.now();
const loginStates = new Map(); // site → { state, authUrl, at }

function maskKey(k) {
  if (!k) return '';
  return k.length <= 10 ? '***' : k.slice(0, 6) + '…' + k.slice(-4);
}

async function siteSummary(cfg, site) {
  const a = getAuth(site);
  const s = cfg.sites[site];
  const cat = await getCatalog(cfg, site);
  return {
    site,
    label: s.label,
    apiBase: s.apiBase,
    enabled: s.enabled !== false,
    clone_of: s.cloneOf || null,
    group: slotGroupOf(s, site),
    is_default: cfg.defaultSite === site,
    logged_in: isLoggedIn(site),
    uid: a.uid || null,
    nickname: a.nickname || null,
    domain: a.domain || null,
    token_expires_at: a.expiresAt ? new Date(a.expiresAt).toISOString() : null,
    model_count: cat.models.size,
    catalog_source: cat.source || null,
    catalog_error: cat.error || null,
  };
}

/** 探测单个模型是否可用（不消耗或极少消耗额度）。 */
async function probeModel(cfg, site, model) {
  const t0 = Date.now();
  try {
    const up = await openChat(cfg, site, {
      model,
      stream: true,
      // max_tokens 给 1 会被部分上游 provider 判为非法参数（400 request parameters were rejected），
      // 给 16 几乎不耗额度，又能真实反映模型可用性。
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
    }, {});
    if (!up.ok) {
      return { model, site, status: up.status, ok: false, msg: upstreamErrorMessage(up.status, up.text, site), ms: Date.now() - t0 };
    }
    let first = null;
    let real = null; // 上游真实应答模型（如 auto → hy4-preview）
    try {
      for await (const payload of up.frames) {
        const parsed = classifyFrame(payload);
        first = parsed;
        if (parsed.kind === 'chunk' && parsed.obj?.model) real = parsed.obj.model;
        break;
      }
    } finally {
      up.close();
    }
    if (first?.kind === 'error') return { model, site, status: 502, ok: false, msg: first.message, ms: Date.now() - t0, real_model: real };
    return { model, site, status: 200, ok: true, msg: '可用', ms: Date.now() - t0, real_model: real };
  } catch (e) {
    return { model, site, status: 0, ok: false, msg: e.message, ms: Date.now() - t0 };
  }
}

export async function handleConsoleApi(ctx) {
  const { cfg, req, res, url } = ctx;
  const p = url.pathname.replace(/^\/console\/api/, '') || '/';
  const method = req.method;

  // ---- 状态总览 ----
  if (p === '/state' && method === 'GET') {
    const sites = [];
    for (const s of siteKeys(cfg)) {
      const info = await siteSummary(cfg, s);
      if (info.logged_in) {
        try {
          const credit = await queryCredit(cfg, s);
          info.credit = credit.remain;
          info.credit_detail = credit.detail;
          if (typeof credit.remain === 'number') recordBalance(s, credit.remain);
        } catch (e) {
          info.credit_error = e.message.slice(0, 160);
        }
      }
      sites.push(info);
    }
    return sendJson(res, 200, {
      version: '1.1.0',
      uptime_ms: Date.now() - startedAt,
      node: process.version,
      platform: process.platform,
      default_site: cfg.defaultSite,
      default_model: cfg.defaultModel,
      api_key: cfg.apiKey,
      api_key_masked: maskKey(cfg.apiKey),
      base_url: `http://${cfg.host}:${cfg.port}/v1`,
      full_url: `http://${cfg.host}:${cfg.port}/v1/chat/completions`,
      sites,
      groups: siteGroups(cfg),
    });
  }

  // ---- 模型清单（含 default 虚拟模型） ----
  if (p === '/models' && method === 'GET') {
    const merged = await mergedModels(cfg);
    const list = merged.map((m) => ({
      id: m.id,
      site: m.site,
      name: m.info?.name || m.id,
      credits: m.info?.credits || null,
      multiplier: Number.isFinite(m.mult) ? m.mult : null,
      context: m.info?.contextWindow || null,
      max_output: m.info?.maxTokens || null,
      alias_of: m.aliasOf || null,
      free: m.mult === 0,
    }));
    // 未登录站点的内置清单也列出来，方便用户知道有哪些可登
    for (const s of siteKeys(cfg)) {
      if (isLoggedIn(s)) continue;
      for (const m of cfg.sites[s].seedModels || []) {
        if (!list.some((x) => x.id === m.id && x.site === s)) {
          list.push({ id: `${s}/${m.id}`, site: s, name: `${m.name}（${s} 未登录）`, credits: null, multiplier: null, pending_login: true });
        }
      }
    }
    return sendJson(res, 200, {
      default_model: cfg.defaultModel,
      default_site: cfg.defaultSite,
      aliases: cfg.modelAliases || {},
      model_routes: cfg.modelRoutes || {},
      data: list,
    });
  }

  // ---- 一键切换默认模型（Trae 侧只配 model=default） ----
  if (p === '/default-model' && method === 'POST') {
    const body = ctx.body || {};
    const model = String(body.model || '').trim();
    if (!model) return sendJson(res, 400, { error: '缺少 model' });
    cfg.defaultModel = model;
    if (body.site) cfg.defaultSite = String(body.site);
    saveConfig(cfg);
    return sendJson(res, 200, { ok: true, default_model: cfg.defaultModel, default_site: cfg.defaultSite });
  }

  // ---- 站点启停 ----
  if (p === '/site' && method === 'POST') {
    const body = ctx.body || {};
    const site = String(body.site || '');
    if (!cfg.sites[site]) return sendJson(res, 400, { error: `未知站点 ${site}` });
    if (typeof body.enabled === 'boolean') cfg.sites[site].enabled = body.enabled;
    if (body.label) cfg.sites[site].label = String(body.label);
    if (Array.isArray(body.seedModels)) cfg.sites[site].seedModels = body.seedModels;
    saveConfig(cfg);
    return sendJson(res, 200, { ok: true, site: cfg.sites[site] });
  }

  // ---- 别名管理 ----
  if (p === '/aliases' && method === 'POST') {
    const body = ctx.body || {};
    const aliases = body.aliases;
    if (!aliases || typeof aliases !== 'object') return sendJson(res, 400, { error: '缺少 aliases 对象' });
    cfg.modelAliases = aliases;
    saveConfig(cfg);
    return sendJson(res, 200, { ok: true, aliases: cfg.modelAliases });
  }

  // ---- 一键签到 ----
  if (p === '/checkin/status' && method === 'GET') {
    const sites = url.searchParams.getAll('site').filter(Boolean);
    return sendJson(res, 200, await checkinStatusAll(cfg, sites.length ? sites : undefined));
  }
  if (p === '/checkin/claim' && method === 'POST') {
    const body = ctx.body || {};
    const sites = Array.isArray(body.sites) ? body.sites : (body.site ? [body.site] : undefined);
    try {
      const r = await checkinAll(cfg, sites);
      const { recordCheckinRun } = await import('./auto-checkin.mjs');
      recordCheckinRun(r, { trigger: 'manual' });
      return sendJson(res, 200, r);
    } catch (e) {
      const status = e instanceof CheckinError ? (e.status || 500) : 500;
      return sendJson(res, status, { ok: false, error: e.message });
    }
  }
  if (p === '/checkin/growth' && method === 'POST') {
    const body = ctx.body || {};
    const sites = Array.isArray(body.sites) ? body.sites : (body.site ? [body.site] : undefined);
    const r = await runGrowthAll(cfg, sites, { includeCheckin: body.includeCheckin !== false });
    const { recordCheckinRun } = await import('./auto-checkin.mjs');
    recordCheckinRun({ claimed: r.results.reduce((n, x) => n + (x.creditsGained || 0), 0), count: r.count, results: r.results }, { trigger: 'growth' });
    return sendJson(res, 200, r);
  }
  if (p === '/checkin/auto' && method === 'GET') {
    return sendJson(res, 200, autoCheckinStatus());
  }
  if (p === '/checkin/auto' && method === 'POST') {
    const body = ctx.body || {};
    return sendJson(res, 200, setAutoCheckin(body));
  }

  // ---- 日志 ----
  if (p === '/logs' && method === 'GET') {
    const after = Number(url.searchParams.get('after') || 0);
    return sendJson(res, 200, recentLogs(after));
  }

  // ---- 用量统计 ----
  if (p === '/usage' && method === 'GET') {
    const days = Number(url.searchParams.get('days') || 7);
    return sendJson(res, 200, usageSnapshot(days));
  }
  if (p === '/usage/reset' && method === 'POST') {
    resetUsage();
    return sendJson(res, 200, { ok: true });
  }

  // ---- 模型探测（顺序执行，避免打爆上游） ----
  if (p === '/probe' && method === 'POST') {
    const body = ctx.body || {};
    const targets = Array.isArray(body.targets) ? body.targets.slice(0, 60) : [];
    const results = [];
    for (const t of targets) {
      const site = String(t.site || cfg.defaultSite);
      const model = String(t.model || '');
      if (!model || !cfg.sites[site]) continue;
      results.push(await probeModel(cfg, site, model));
      await new Promise((r) => setTimeout(r, 250));
    }
    return sendJson(res, 200, { ok: true, count: results.length, results });
  }

  // ---- 账号登录（设备授权，按槽位键隔离：每个账号槽位独立走一遍授权） ----
  if (p === '/login/start' && method === 'POST') {
    const body = ctx.body || {};
    const site = String(body.site || cfg.defaultSite);
    if (!cfg.sites[site]) return sendJson(res, 400, { error: `未知站点 ${site}` });
    const r = await startLogin(cfg, site);
    loginStates.set(site, r);
    return sendJson(res, 200, r);
  }
  if (p === '/login/poll' && method === 'GET') {
    const site = String(url.searchParams.get('site') || cfg.defaultSite);
    const st = loginStates.get(site);
    if (!st) return sendJson(res, 400, { error: '请先点击「开始登录」' });
    const r = await pollLogin(cfg, site, st.state);
    if (r.done) {
      loginStates.delete(site);
      clearCatalog(site); // 登录成功：清该站点目录缓存，立即可见最新模型清单
      return sendJson(res, 200, { done: true, uid: r.auth.uid, nickname: r.auth.nickname, expires_at: r.auth.expiresAt });
    }
    return sendJson(res, 200, { done: false, msg: r.msg });
  }
  if (p === '/login/logout' && method === 'POST') {
    const body = ctx.body || {};
    const site = String(body.site || '');
    if (!cfg.sites[site]) return sendJson(res, 400, { error: `未知站点 ${site}` });
    // 只清空本项目内的凭证文件，不动客户端
    const { authPathFor } = await import('./config.mjs');
    const fs = await import('node:fs');
    try {
      fs.rmSync(authPathFor(site), { force: true });
      if (site === 'cn-cli') fs.rmSync((await import('./config.mjs')).paths.legacyAuth, { force: true });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
    clearCatalog(site); // 退出登录：清该站点目录缓存
    return sendJson(res, 200, { ok: true, site });
  }

  // ---- 服务控制 ----
  if (p === '/service/stop' && method === 'POST') {
    sendJson(res, 200, { ok: true, message: 'shutting down' });
    flushUsage();
    setTimeout(() => process.exit(0), 200);
    return;
  }

  // ---- 同源多账号（账号池）：克隆槽位 / 删除槽位 / 切换默认槽位 ----
  if (p === '/sites' && method === 'POST') {
    const body = ctx.body || {};
    try {
      const r = cloneSiteSlot(cfg, String(body.from || ''), String(body.key || ''), String(body.label || ''));
      clearCatalog(); // 新槽位上线：清目录缓存，保证模型列表/路由即时可见
      const info = await siteSummary(cfg, r.key);
      return sendJson(res, 200, { ok: true, ...r, info, groups: siteGroups(cfg) });
    } catch (e) {
      return sendJson(res, e.status || 400, { error: e.message });
    }
  }
  if (p === '/sites/remove' && method === 'POST') {
    const body = ctx.body || {};
    const key = String(body.site || body.key || '');
    try {
      const r = removeSiteSlot(cfg, key);
      clearCatalog(key); // 槽位下线：清该槽位目录缓存
      const { authPathFor } = await import('./config.mjs');
      const fs = await import('node:fs');
      try { fs.rmSync(authPathFor(key), { force: true }); } catch { /* 凭证删不掉不阻塞 */ }
      return sendJson(res, 200, { ok: true, ...r, groups: siteGroups(cfg) });
    } catch (e) {
      return sendJson(res, e.status || 400, { error: e.message });
    }
  }
  if (p === '/sites/default' && method === 'POST') {
    const body = ctx.body || {};
    const key = String(body.site || body.key || '');
    if (!cfg.sites?.[key]) return sendJson(res, 400, { error: `未知站点 ${key}` });
    cfg.defaultSite = key; // 切默认账号：反代裸模型名/default 别名即走该账号；重启不丢失
    saveConfig(cfg);
    return sendJson(res, 200, { ok: true, default_site: cfg.defaultSite, groups: siteGroups(cfg) });
  }

  return sendJson(res, 404, { error: `未知控制台接口 ${method} ${p}` });
}
