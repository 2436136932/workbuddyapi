// 本地反代服务入口：把 WorkBuddy（CodeBuddy）账号能力暴露为
//   - OpenAI 兼容：/v1/models、/v1/chat/completions
//   - Anthropic 兼容：/v1/messages、/v1/messages/count_tokens
//   - 控制台：/console（本机网页控制台）
//   - 监控：/metrics（Prometheus 文本格式）
// 仅供本机（默认 127.0.0.1）使用，不读写本项目目录以外的任何文件。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig, paths, siteKeys, ROOT, DATA_DIR } from './src/config.mjs';
import { getAuth, isLoggedIn } from './src/auth.mjs';
import { handleChatCompletions, handleModels } from './src/openai.mjs';
import { handleMessages, handleCountTokens } from './src/anthropic.mjs';
import { queryCredit } from './src/upstream.mjs';
import { handleConsoleApi } from './src/console-api.mjs';
import { flushUsage, recordUsage } from './src/usage.mjs';
import { readJsonBody, sendJson, sendError } from './src/util.mjs';
import { resolveCorsOrigin } from './src/cors.mjs';
import { maybeAutoCheckin, autoCheckinStatus } from './src/auto-checkin.mjs';
import { resolvePrincipal, authorizeRequest, acquireSlot, releaseSlot, audit, isIpAllowed } from './src/access.mjs';
import { renderMetrics } from './src/metrics.mjs';
import { log, warn, error } from './src/log.mjs';

const cfg = loadConfig();
const VERSION = '1.2.0';

// 控制台会话 token：每次启动随机生成，注入到控制台页面里；避免把 apiKey 暴露在浏览器中
const CONSOLE_TOKEN = crypto.randomBytes(16).toString('hex');
const CONSOLE_DIR = path.join(ROOT, 'console');

function consoleAuthorized(req) {
  if ((req.headers['x-console-token'] || '') === CONSOLE_TOKEN) return true;
  return masterAuthorized(req); // 也允许直接用主密钥调控制台接口（方便脚本）
}

/** 控制台只认主密钥：普通受限密钥不得管理服务。 */
function masterAuthorized(req) {
  if (!cfg.apiKey) return true; // 未配置密钥则不校验（仅建议本机场景）
  return clientKey(req) === cfg.apiKey;
}

/** 汇总各站点登录状态。 */
function siteState(cfgIn) {
  return siteKeys(cfgIn).map((site) => {
    const a = getAuth(site);
    return {
      site,
      label: cfgIn.sites[site].label,
      apiBase: cfgIn.sites[site].apiBase,
      logged_in: isLoggedIn(site),
      uid: a.uid ? String(a.uid).slice(0, 8) + '…' : null,
      nickname: a.nickname || null,
      token_expires_at: a.expiresAt ? new Date(a.expiresAt).toISOString() : null,
    };
  });
}

function clientKey(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return (req.headers['x-api-key'] || '').toString().trim() || auth.trim();
}

/** 取客户端来源 IP（本机场景下即 req.socket.remoteAddress）。 */
function clientIp(req) {
  return req.socket?.remoteAddress || '';
}

const startedAt = Date.now();

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const ip = clientIp(req);

  // CORS：只对本机来源回跨域头，杜绝任意网页借用本机代理（DNS rebinding / 白嫖额度）
  const cors = resolveCorsOrigin(cfg, req);
  if (!cors.allowed) {
    warn(`拒绝来源 ${cors.origin} 的请求（${req.method} ${pathname}）：如需放行请写入 config.json 的 cors.allowOrigins`);
    audit({ ip, method: req.method, path: pathname, status: 403, denied: true, reason: 'cors_origin' }, cfg);
    if (req.method === 'OPTIONS') {
      res.writeHead(403);
      return res.end();
    }
    return sendError(res, 403, '不允许的跨站来源（Origin）：如需放行，请把该来源加入 config.json 的 cors.allowOrigins');
  }
  if (cors.origin) {
    res.setHeader('Access-Control-Allow-Origin', cors.origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-api-key, x-console-token, anthropic-version, x-requested-with');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // 来源 IP 白名单：在鉴权之前拦截（配置为空则不限制）
  if (!isIpAllowed(ip, cfg.access?.ipAllowList)) {
    warn(`拒绝来源 IP ${ip} 的请求（${req.method} ${pathname}）`);
    audit({ ip, method: req.method, path: pathname, status: 403, denied: true, reason: 'ip_not_allowed' }, cfg);
    return sendError(res, 403, `来源 IP ${ip} 不在允许列表内（config.json 的 access.ipAllowList）`, 'ip_not_allowed');
  }

  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort(new Error('client closed'));
  });

  // 审计：同一个请求只记一次，且状态码取「响应真正完成时」的值。
  // 用 res 的 finish/close 事件收尾，避免 handler 抛错时把 200 记成成功。
  let audited = false;
  const auditCtx = {};
  const flushAudit = (status) => {
    if (audited) return;
    if (pathname === '/health' || pathname === '/healthz') return;
    audited = true;
    audit({
      ip, method: req.method, path: pathname,
      ms: Date.now() - started,
      // 上下文字段在前，真实状态码在后，保证 status 不被覆盖
      ...auditCtx,
      status: status ?? res.statusCode ?? 200,
    }, cfg);
  };
  res.on('finish', () => flushAudit(res.statusCode));
  res.on('close', () => flushAudit(res.statusCode));
  /** 只登记上下文字段；真正的落盘由 finish/close 统一触发。 */
  const auditDone = (fields) => Object.assign(auditCtx, fields);

  try {
    // 无需鉴权：健康检查
    if (pathname === '/health' || pathname === '/healthz') {
      const sites = siteState(cfg);
      return sendJson(res, 200, {
        status: sites.some((s) => s.logged_in) ? 'ok' : 'not_logged_in',
        service: 'workbuddyapi',
        version: VERSION,
        sites,
        logged_in: sites.some((s) => s.logged_in),
      });
    }

    // 控制台页面（本机可达；页面内注入会话 token，不含 apiKey）
    if ((pathname === '/console' || pathname === '/console/') && req.method === 'GET') {
      const file = path.join(CONSOLE_DIR, 'index.html');
      if (!fs.existsSync(file)) return sendError(res, 500, '控制台文件缺失：console/index.html');
      let html = fs.readFileSync(file, 'utf8');
      html = html.replace('<head>', `<head>\n<script>window.__WB_TOKEN__=${JSON.stringify(CONSOLE_TOKEN)};</script>`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    // 控制台 API（用会话 token 或主密钥鉴权）
    if (pathname.startsWith('/console/api/')) {
      if (!consoleAuthorized(req)) {
        warn(`控制台接口鉴权失败：${req.method} ${pathname}`);
        auditDone({ denied: true, reason: 'console_token' });
        return sendError(res, 401, '控制台会话失效：请刷新页面重开 /console', 'invalid_console_token');
      }
      const body = req.method === 'POST' ? await readJsonBody(req) : null;
      return await handleConsoleApi({ cfg, req, res, url, body, ip, version: VERSION });
    }

    // ---- Prometheus 指标（需鉴权：含密钥名与用量）----
    if (pathname === '/metrics' && req.method === 'GET') {
      if (cfg.metrics?.enabled === false) {
        return sendError(res, 404, '指标已关闭（config.json 的 metrics.enabled=false）', 'metrics_disabled');
      }
      const p = resolvePrincipal(cfg, clientKey(req));
      if (!p.ok) {
        auditDone({ denied: true, reason: p.reason });
        return sendError(res, 401, 'API Key 不正确', 'invalid_api_key');
      }
      const text = renderMetrics({ cfg, startedAt, version: VERSION });
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
      auditDone({ keyId: p.principal.keyId, keyName: p.principal.name, kind: 'metrics' });
      return res.end(text);
    }

    // ---- 其余接口都需要 API Key：解析主体 ----
    const auth0 = resolvePrincipal(cfg, clientKey(req));
    if (!auth0.ok) {
      const msg = auth0.reason === 'disabled'
        ? '该 API Key 已被停用'
        : 'API Key 不正确：请在请求头携带 Authorization: Bearer <config.json 里的 apiKey 或 data/keys.json 里的密钥>';
      warn(`未授权的请求被拒绝：${req.method} ${pathname} key=${clientKey(req).slice(0, 6)}…`);
      auditDone({ denied: true, reason: auth0.reason });
      return sendError(res, 401, msg, 'invalid_api_key');
    }
    const principal = auth0.principal;
    auditDone({ keyId: principal.keyId, keyName: principal.name });

    if (pathname === '/') {
      return sendJson(res, 200, {
        service: 'workbuddyapi',
        version: VERSION,
        console: `http://${cfg.host}:${cfg.port}/console`,
        endpoints: ['/v1/models', '/v1/chat/completions', '/v1/messages', '/v1/messages/count_tokens', '/status', '/metrics', '/health', '/console'],
        sites: siteKeys(cfg),
        default_site: cfg.defaultSite,
        default_model: cfg.defaultModel,
        data_dir: DATA_DIR,
        config: paths.config,
      });
    }

    // 各站点登录态 + 剩余积分（含积分组成与各部分到期时间）
    if (pathname === '/status') {
      const only = url.searchParams.get('site');
      const keys = siteKeys(cfg).filter((s) => !only || s === only);
      const out = [];
      for (const site of keys) {
        const a = getAuth(site);
        let credit = null;
        if (isLoggedIn(site)) {
          try {
            credit = await queryCredit(cfg, site);
          } catch (e) {
            credit = { error: e.message };
          }
        }
        out.push({
          site,
          label: cfg.sites[site].label,
          account_label: cfg.sites[site].accountLabel || null,
          apiBase: cfg.sites[site].apiBase,
          logged_in: isLoggedIn(site),
          uid: a.uid ? String(a.uid).slice(0, 8) + '…' : null,
          nickname: a.nickname || null,
          domain: a.domain || null,
          enterprise_id: a.enterpriseId || null,
          token_expires_at: a.expiresAt ? new Date(a.expiresAt).toISOString() : null,
          credit,
        });
      }
      auditDone({ keyId: principal.keyId, keyName: principal.name, kind: 'status' });
      return sendJson(res, 200, { sites: out, default_site: cfg.defaultSite });
    }

    // 优雅停止（供 stop.cmd / stop.mjs 调用；需要主密钥，避免被受限密钥误触）
    if (pathname === '/admin/shutdown' && req.method === 'POST') {
      if (principal.scope !== 'master') {
        auditDone({ denied: true, reason: 'master_required', keyId: principal.keyId });
        return sendError(res, 403, '只有主密钥可以停止服务', 'master_required');
      }
      log('收到停止指令，服务即将退出');
      auditDone({ keyId: principal.keyId, keyName: principal.name });
      sendJson(res, 200, { ok: true, message: 'shutting down' });
      flushUsage();
      setTimeout(() => process.exit(0), 150);
      return;
    }

    // 路径容错：不同客户端拼接方式不同（如 TraeWork 会拼成 /v1/messages/chat/completions），
    // 这里按“路径里是否包含某段”来判断，只要语义明确就命中对应处理器。
    const seg = (s) => pathname.includes(s);
    const isCountTokens = req.method === 'POST' && (seg('/count_tokens') || seg('/count-tokens'));
    const isChat = req.method === 'POST' && seg('/chat/completions');
    const isMessages = req.method === 'POST' && seg('/messages');
    const isModels = req.method === 'GET' && pathname.endsWith('/models');

    if (isChat || isMessages) log(`→ ${req.method} ${pathname}${clientKey(req) ? '' : '（无 Key）'}`);

    if (isModels) {
      auditDone({ keyId: principal.keyId, keyName: principal.name, kind: 'models' });
      return await handleModels({ cfg, req, res });
    }

    if (isCountTokens) {
      const body = await readJsonBody(req);
      auditDone({ keyId: principal.keyId, keyName: principal.name, kind: 'count_tokens' });
      return handleCountTokens({ cfg, req, res, body });
    }

    // 聊天类请求：先做「模型/站点作用域 + 限流配额」校验，再占用并发名额
    if (isChat || isMessages) {
      const body = await readJsonBody(req);
      const requestedModel = String(body.model || cfg.defaultModel);
      const target = await resolveTargetFor(cfg, requestedModel);
      const gate = authorizeRequest({ cfg, principal, ip, model: target.model, site: target.site });
      if (!gate.ok) {
        warn(`[${principal.name}] 请求被拒绝（${gate.code}）：${gate.message}`);
        auditDone({
          denied: true, reason: gate.code,
          keyId: principal.keyId, keyName: principal.name,
          model: target.model, site: target.site,
        });
        return sendError(res, gate.status, gate.message, gate.code);
      }

      acquireSlot(principal.keyId);
      let creditUsed = 0;
      const chatStarted = Date.now();
      try {
        const handler = isChat ? handleChatCompletions : handleMessages;
        // handler 内部会调用 recordUsage；ctx.principal 用于按密钥统计
        const result = await handler({ cfg, req, res, body, signal: ac.signal, pathname, principal });
        creditUsed = Number(result?.credit) || 0;
        return result;
      } catch (e) {
        // handler 抛错（如上游未登录导致 token 获取失败）：补记一次失败调用，
        // 否则该请求不会出现在用量统计里。
        recordUsage({
          site: target.site, model: target.model,
          mode: isChat ? 'chat' : 'messages',
          status: e.status || 502,
          ms: Date.now() - chatStarted,
          keyId: principal.keyId, keyName: principal.name,
        });
        throw e;
      } finally {
        releaseSlot(principal.keyId, creditUsed);
        auditDone({
          keyId: principal.keyId, keyName: principal.name,
          model: target.model, site: target.site,
          mode: isChat ? 'chat' : 'messages',
          credit: creditUsed || undefined,
        });
      }
    }

    warn(`收到未知路径请求：${req.method} ${pathname}（可选路径见 GET /）`);
    auditDone({ keyId: principal.keyId, reason: 'not_found' });
    return sendError(
      res,
      404,
      `未知路径 ${req.method} ${pathname}。可用：/v1/chat/completions（OpenAI 格式）、/v1/messages（Anthropic 格式）、/v1/models`,
      'not_found',
    );
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) error(`${req.method} ${pathname} 处理失败：`, e.stack || e.message);
    auditDone({ reason: 'exception', error: e.message });
    if (!res.headersSent) sendError(res, status, e.message || 'internal error');
    else if (!res.writableEnded) res.end();
  }
});

/** 延迟引入 router，避免顶层循环依赖；仅用于作用域校验。 */
let _resolveTarget = null;
async function resolveTargetFor(cfgIn, model) {
  if (!_resolveTarget) {
    const mod = await import('./src/router.mjs');
    _resolveTarget = mod.resolveTarget;
  }
  try {
    return await _resolveTarget(cfgIn, model);
  } catch {
    // 目录不可用时退化为「默认站点 + 原始模型名」，不因解析失败而拒绝请求
    return { site: cfgIn.defaultSite, model, requested: model };
  }
}

server.keepAliveTimeout = 120000;
server.requestTimeout = 0; // 流式长连接不设总时长上限

server.listen(cfg.port, cfg.host, () => {
  log(`WorkBuddy 反代已启动（国内版 + 国际版多站点）v${VERSION}`);
  if (!cfg.apiKey) warn('未配置 apiKey：本机任意程序都可调用本代理，建议在 config.json 里设置 apiKey');
  log(`  控制台：http://${cfg.host}:${cfg.port}/console   ← 建议用桌面快捷方式打开`);
  log(`  监听地址：http://${cfg.host}:${cfg.port}   （仅本机可达）`);
  log(`  API Key：${cfg.apiKey}`);
  log(`  数据目录：${DATA_DIR}`);
  log(`  默认站点/模型：${cfg.defaultSite} / ${cfg.defaultModel}    配置文件：${paths.config}`);
  for (const s of siteState(cfg)) {
    log(`  站点 ${s.site.padEnd(9)} ${s.logged_in ? `已登录 uid=${s.uid}` : '未登录'}   ${s.apiBase}`);
  }
  log('  未登录的站点可在控制台「账号登录」里点一下，或运行：node login.mjs --site <站点名>');
  log(`  OpenAI 客户端：Base URL = http://${cfg.host}:${cfg.port}/v1`);
  if (cfg.metrics?.enabled !== false) log(`  监控指标：http://${cfg.host}:${cfg.port}/metrics（Prometheus 文本格式）`);
  const auto = autoCheckinStatus();
  log(`  自动签到：${auto.enabled ? `已开启（每天 ${String(auto.hour).padStart(2, '0')}:${String(auto.minute).padStart(2, '0')}，服务常驻时自动执行）` : '未开启（控制台「一键签到」里可开，或运行 node checkin.mjs）'}`);
  // 自动签到：每分钟检查一次（到点且今日未跑 → 跑一轮）。服务没启动时不会跑，
  // Windows 常驻建议用 checkin-scheduled.cmd 注册计划任务（见 README 第 6 节）。
  setInterval(() => { maybeAutoCheckin(cfg); }, 60 * 1000).unref?.();
  setTimeout(() => { maybeAutoCheckin(cfg); }, 30 * 1000).unref?.();
});

process.on('SIGINT', () => {
  log('收到退出信号，正在保存用量统计并关闭服务');
  flushUsage();
  server.close(() => process.exit(0));
});
process.on('unhandledRejection', (e) => error('未处理的 Promise 异常：', e));