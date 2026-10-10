// 控制台后端 API：状态总览 / 模型清单 / 一键切换默认模型 / 一键签到 / 日志 / 用量 / 探测 / 登录 / 停服
//              + 访问密钥管理 / 审计查询 / 监控数据 / 用量导出 / 积分组成
// 仅本机可用（服务只监听 127.0.0.1），鉴权用控制台会话 token 或 config.json 的主密钥。
import { siteKeys, saveConfig, siteGroups, slotGroupOf, cloneSiteSlot, removeSiteSlot, paths, DATA_DIR } from './config.mjs';
import { getAuth, isLoggedIn } from './auth.mjs';
import { getCatalog, mergedModels, parseMultiplier, clearCatalog } from './router.mjs';
import { queryCredit, openChat, classifyFrame, upstreamErrorMessage } from './upstream.mjs';
import { checkinStatusAll, checkinAll, runGrowthAll, CheckinError } from './checkin.mjs';
import { autoCheckinStatus, setAutoCheckin } from './auto-checkin.mjs';
import { startLogin, pollLogin } from './device-login.mjs';
import { usageSnapshot, resetUsage, flushUsage, recordBalance, dailyRows } from './usage.mjs';
import { listKeys, createKey, updateKey, removeKey, recentAudit, tailAuditFile, rateSnapshot, clearAuditBuffer } from './access.mjs';
import { humanizeUntil } from './credit.mjs';
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
    // 自定义备注名：便于区分同组里的多个账号（可在控制台编辑）
    account_label: s.accountLabel || null,
    apiBase: s.apiBase,
    enabled: s.enabled !== false,
    clone_of: s.cloneOf || null,
    group: slotGroupOf(s, site),
    is_default: cfg.defaultSite === site,
    logged_in: isLoggedIn(site),
    uid: a.uid || null,
    nickname: a.nickname || null,
    domain: a.domain || null,
    enterprise_id: a.enterpriseId || null,
    login_at: a.savedAt || null,
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
          // 积分组成 + 各部分到期时间（新的展示重点）
          info.credit_parts = credit.parts || [];
          info.credit_packages = credit.packages || [];
          info.credit_next_expiry = credit.nextExpiry || null;
          info.credit_last_expiry = credit.lastExpiry || null;
          info.credit_package_count = credit.packageCount || 0;
          info.credit_updated_at = credit.updatedAt || null;
          // 给每个组成部分补上「还有多久到期」的人类可读描述
          info.credit_parts = info.credit_parts.map((x) => ({
            ...x,
            earliest_expiry_human: humanizeUntil(x.earliestExpiry),
            latest_expiry_human: humanizeUntil(x.latestExpiry),
          }));
          if (typeof credit.remain === 'number') recordBalance(s, credit.remain);
        } catch (e) {
          info.credit_error = e.message.slice(0, 160);
        }
      }
      sites.push(info);
    }
    return sendJson(res, 200, {
      version: ctx.version || '1.2.0',
      uptime_ms: Date.now() - startedAt,
      node: process.version,
      platform: process.platform,
      default_site: cfg.defaultSite,
      default_model: cfg.defaultModel,
      api_key: cfg.apiKey,
      api_key_masked: maskKey(cfg.apiKey),
      base_url: `http://${cfg.host}:${cfg.port}/v1`,
      full_url: `http://${cfg.host}:${cfg.port}/v1/chat/completions`,
      data_dir: DATA_DIR,
      metrics_url: `http://${cfg.host}:${cfg.port}/metrics`,
      metrics_enabled: cfg.metrics?.enabled !== false,
      ip_allowlist: cfg.access?.ipAllowList || [],
      audit_enabled: cfg.access?.audit?.enabled !== false,
      sites,
      groups: siteGroups(cfg),
    });
  }

  // ---- 监控总览（延迟分位 / 小时分布 / 按站点 / 按密钥）----
  if (p === '/monitor' && method === 'GET') {
    const days = Number(url.searchParams.get('days') || 7);
    const u = usageSnapshot(days);
    return sendJson(res, 200, {
      uptime_ms: Date.now() - startedAt,
      node: process.version,
      rss_bytes: process.memoryUsage().rss,
      totals: u.totals,
      today: u.today,
      totalLatency: u.totalLatency,
      latencyBucketsMs: u.latencyBucketsMs,
      latencyBuckets: u.latencyBuckets,
      bySite: u.bySite,
      byKey: u.byKey,
      hours: u.hours,
      recent: u.recent,
      rates: rateSnapshot(),
      since: u.since,
    });
  }

  // ---- 积分组成与到期时间（单独查询，便于控制台局部刷新）----
  if (p === '/credit' && method === 'GET') {
    const only = url.searchParams.getAll('site').filter(Boolean);
    const keys = siteKeys(cfg).filter((s) => !only.length || only.includes(s));
    const includeInactive = url.searchParams.get('inactive') === '1';
    const out = [];
    for (const site of keys) {
      const a = getAuth(site);
      const s = cfg.sites[site];
      // 统一响应形状：无论是否登录 / 是否查询成功，这些字段都存在，
      // 前端不必做存在性判断（未登录时为空数组 / null）。
      const base = {
        site,
        label: s.label,
        account_label: s.accountLabel || null,
        nickname: a.nickname || null,
        uid: a.uid || null,
        enterprise_id: a.enterpriseId || null,
        logged_in: isLoggedIn(site),
        remain: null,
        size: null,
        used: null,
        unit: 'credits',
        packageCount: 0,
        inactiveCount: 0,
        parts: [],
        packages: [],
        inactive: [],
        nextExpiry: null,
        lastExpiry: null,
        lastExpiryHuman: '—',
        updatedAt: null,
        error: null,
      };
      if (!base.logged_in) {
        out.push(base);
        continue;
      }
      try {
        const credit = await queryCredit(cfg, site, { includeInactive });
        out.push({
          ...base,
          remain: credit.remain,
          size: credit.size,
          used: credit.used,
          unit: credit.unit,
          packageCount: credit.packageCount,
          inactiveCount: credit.inactiveCount,
          parts: (credit.parts || []).map((x) => ({
            ...x,
            earliestExpiryHuman: humanizeUntil(x.earliestExpiry),
            latestExpiryHuman: humanizeUntil(x.latestExpiry),
          })),
          packages: (credit.packages || []).map((x) => ({
            ...x,
            expiryHuman: humanizeUntil(x.expiry),
          })),
          inactive: (credit.inactive || []).map((x) => ({ ...x, expiryHuman: humanizeUntil(x.expiry) })),
          nextExpiry: credit.nextExpiry
            ? { ...credit.nextExpiry, human: humanizeUntil(credit.nextExpiry.expiry) }
            : null,
          lastExpiry: credit.lastExpiry,
          lastExpiryHuman: humanizeUntil(credit.lastExpiry),
          updatedAt: credit.updatedAt,
        });
      } catch (e) {
        out.push({ ...base, error: e.message.slice(0, 200) });
      }
    }
    return sendJson(res, 200, { data: out });
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

  // ---- 账号备注名（用于区分同组里的多个账号）----
  if (p === '/site/account-label' && method === 'POST') {
    const body = ctx.body || {};
    const site = String(body.site || '');
    if (!cfg.sites[site]) return sendJson(res, 400, { error: `未知站点 ${site}` });
    const label = String(body.accountLabel ?? '').trim();
    if (label) cfg.sites[site].accountLabel = label.slice(0, 60);
    else delete cfg.sites[site].accountLabel; // 清空即恢复默认显示
    saveConfig(cfg);
    return sendJson(res, 200, { ok: true, site, account_label: cfg.sites[site].accountLabel || null });
  }

  // ---- 主密钥（apiKey）在线修改：可在 Web 端自定义 ----
  if (p === '/api-key' && method === 'POST') {
    const body = ctx.body || {};
    const next = String(body.apiKey ?? '');
    // 留空 = 关闭鉴权（仅本机使用场景）；非空则做基本校验（不强制长度，避免挡住用户自己的短密钥）
    if (next && next.length < 4) {
      return sendJson(res, 400, { error: '新密钥至少 4 位（留空表示关闭鉴权，仅建议本机使用）' });
    }
    if (/\s/.test(next)) return sendJson(res, 400, { error: '新密钥不能包含空白字符' });
    const old = cfg.apiKey;
    cfg.apiKey = next;
    saveConfig(cfg);
    // 安全性提示：密钥太短时给出弱口令警告（不阻止，尊重用户选择）
    const weak = next && next.length < 8;
    return sendJson(res, 200, {
      ok: true,
      api_key: cfg.apiKey,
      api_key_masked: maskKey(cfg.apiKey),
      changed: old !== next,
      weak: Boolean(weak),
      note: !next
        ? '已清空主密钥：现在本机任意程序都可调用本代理（不建议）。'
        : weak
          ? '已更新主密钥。当前密钥较短，容易被猜到，建议用「随机生成」换一个更长的。'
          : '已更新主密钥：使用旧密钥的客户端会立即失效，请同步更新各客户端的 API Key。',
    });
  }

  // ---- 随机生成一个强主密钥（不落盘，返回给用户确认后再保存）----
  if (p === '/api-key/generate' && method === 'GET') {
    const { generateKey } = await import('./access.mjs');
    // 主密钥用较长随机串，前缀区分于受限密钥（受限密钥由 keys.json 管理）
    return sendJson(res, 200, { ok: true, suggestion: generateKey() });
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
  // 导出用量（CSV）：按天明细，浏览器直接下载
  if (p === '/usage/export' && method === 'GET') {
    const rows = dailyRows();
    const head = ['date', 'calls', 'errors', 'promptTokens', 'completionTokens', 'credit', 'avgMs'];
    const csv = [head.join(','), ...rows.map((r) => head.map((h) => r[h] ?? 0).join(','))].join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="workbuddy-usage-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
    });
    // BOM：让 Excel 正确识别 UTF-8
    return res.end('\uFEFF' + csv);
  }

  // ---- 访问密钥管理（明文只在创建时返回一次）----
  if (p === '/keys' && method === 'GET') {
    return sendJson(res, 200, { data: listKeys(), rates: rateSnapshot() });
  }
  if (p === '/keys' && method === 'POST') {
    const body = ctx.body || {};
    try {
      const r = createKey(body);
      return sendJson(res, 200, { ok: true, id: r.id, plain: r.plain, key: r.key });
    } catch (e) {
      return sendJson(res, e.status || 400, { error: e.message });
    }
  }
  if (p === '/keys/update' && method === 'POST') {
    const body = ctx.body || {};
    try {
      const { id, ...patch } = body;
      return sendJson(res, 200, { ok: true, key: updateKey(String(id || ''), patch) });
    } catch (e) {
      return sendJson(res, e.status || 400, { error: e.message });
    }
  }
  if (p === '/keys/remove' && method === 'POST') {
    const body = ctx.body || {};
    try {
      return sendJson(res, 200, { ok: true, ...removeKey(String(body.id || '')) });
    } catch (e) {
      return sendJson(res, e.status || 400, { error: e.message });
    }
  }

  // ---- 访问控制策略（IP 白名单 / 审计开关）----
  if (p === '/access' && method === 'GET') {
    return sendJson(res, 200, {
      master: cfg.access?.master || {},
      ipAllowList: cfg.access?.ipAllowList || [],
      audit: cfg.access?.audit || {},
      metrics: cfg.metrics || {},
      client_ip: ctx.ip || null,
    });
  }
  if (p === '/access' && method === 'POST') {
    const body = ctx.body || {};
    if (Array.isArray(body.ipAllowList)) cfg.access.ipAllowList = body.ipAllowList.map((s) => String(s).trim()).filter(Boolean);
    if (body.audit && typeof body.audit === 'object') {
      if (body.audit.enabled !== undefined) cfg.access.audit.enabled = Boolean(body.audit.enabled);
      if (body.audit.maxEntries !== undefined) cfg.access.audit.maxEntries = Math.max(50, Number(body.audit.maxEntries) || 2000);
    }
    if (body.metrics && typeof body.metrics === 'object' && body.metrics.enabled !== undefined) {
      cfg.metrics.enabled = Boolean(body.metrics.enabled);
    }
    if (body.master && typeof body.master === 'object') {
      cfg.access.master = { ...(cfg.access.master || {}), ...body.master };
    }
    saveConfig(cfg);
    return sendJson(res, 200, { ok: true, ipAllowList: cfg.access.ipAllowList, audit: cfg.access.audit, metrics: cfg.metrics, master: cfg.access.master });
  }

  // ---- 审计日志（内存优先；?from=file 读磁盘尾部）----
  if (p === '/audit' && method === 'GET') {
    const limit = Number(url.searchParams.get('limit') || 200);
    const keyId = url.searchParams.get('key') || null;
    const onlyErrors = url.searchParams.get('errors') === '1';
    const onlyDenied = url.searchParams.get('denied') === '1';
    const fromFile = url.searchParams.get('from') === 'file';
    const list = fromFile
      ? tailAuditFile(limit).filter((r) => (!keyId || r.keyId === keyId) && (!onlyErrors || r.status >= 400) && (!onlyDenied || r.denied))
      : recentAudit({ limit, keyId, onlyErrors, onlyDenied });
    return sendJson(res, 200, { data: list, source: fromFile ? 'file' : 'memory', path: paths.audit });
  }
  if (p === '/audit/clear' && method === 'POST') {
    clearAuditBuffer();
    return sendJson(res, 200, { ok: true, note: '已清空内存审计缓冲；磁盘 audit.log 未改动' });
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
