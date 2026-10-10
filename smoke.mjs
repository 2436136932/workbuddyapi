// 端到端冒烟测试：用独立数据目录 + 空闲端口启动服务，验证鉴权 / 作用域 / 限流 /
// 指标 / 审计 / 积分 / 账号备注名 / 主密钥在线修改 / data 目录布局。
//
//   node smoke.mjs            自动选端口、跑完自动停服并清理
//   node smoke.mjs --keep     保留数据目录与日志，便于排查
//
// 零依赖：只用 node:child_process 起服务，用内置 fetch 发请求。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEEP = process.argv.includes('--keep');
const PORT = Number(process.env.SMOKE_PORT || 18799);
const DATA = path.join(os.tmpdir(), `wb-smoke-${process.pid}`);
const LOG = path.join(os.tmpdir(), `wb-smoke-${process.pid}.log`);
const BASE = `http://127.0.0.1:${PORT}`;
const MASTER = '123456';

let pass = 0;
let fail = 0;
const failures = [];
function chk(name, ok, extra = '') {
  if (ok) {
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${extra ? '  → ' + extra : ''}`);
    failures.push(name);
    fail++;
  }
}
function section(t) {
  console.log(`\n\x1b[1m=== ${t} ===\x1b[0m`);
}

async function call(pathname, { method = 'GET', body, key = MASTER, raw = false } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return { status: res.status, text: await res.text(), headers: res.headers };
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json, text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 启动服务 ----------
fs.mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: import.meta.dirname,
  env: { ...process.env, WB_DATA_DIR: DATA, WB_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });

function cleanup() {
  try { child.kill(); } catch { /* 已退出 */ }
  if (!KEEP) {
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
    try { fs.rmSync(LOG, { force: true }); } catch { /* 忽略 */ }
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// 等服务就绪
let up = false;
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(BASE + '/health');
    if (r.ok) { up = true; break; }
  } catch { /* 还没起来 */ }
  await sleep(300);
}
if (!up) {
  console.error('服务启动失败。日志：\n' + serverLog);
  process.exit(1);
}
console.log(`服务已就绪：${BASE}   数据目录：${DATA}`);

try {
  // ---------- 1. 基础鉴权 ----------
  section('1. 启动与基础鉴权');
  chk('health 无需鉴权', (await fetch(BASE + '/health')).status === 200);
  chk('无 Key 访问 / 被拒', (await call('/', { key: '' })).status === 401);
  chk('主密钥访问 / 成功', (await call('/')).status === 200);
  chk('/health 带版本号', (await (await fetch(BASE + '/health')).json()).version === '1.2.0');

  // ---------- 2. 密钥管理 ----------
  section('2. 密钥管理（哈希存储 + 明文只返回一次）');
  const created = await call('/console/api/keys', {
    method: 'POST',
    body: { name: '冒烟密钥', sites: ['intl-cli'], models: ['deepseek*'], rpm: 2 },
  });
  const PLAIN = created.json?.plain;
  const KEYID = created.json?.id;
  chk('创建密钥返回明文', Boolean(PLAIN) && PLAIN.startsWith('wb-'));
  const keysFile = fs.readFileSync(path.join(DATA, 'keys.json'), 'utf8');
  chk('keys.json 不含明文（只存哈希）', !keysFile.includes(PLAIN));
  chk('keys.json 含 sha256 哈希', /"id": "[0-9a-f]{64}"/.test(keysFile));
  const listed = await call('/console/api/keys');
  chk('列表返回掩码而非明文', !JSON.stringify(listed.json).includes(PLAIN));
  chk('受限密钥可访问 /status', (await call('/status', { key: PLAIN })).status === 200);
  chk('受限密钥不得停服', (await call('/admin/shutdown', { method: 'POST', key: PLAIN })).status === 403);
  chk('受限密钥不得改主密钥', (await call('/console/api/api-key', { method: 'POST', key: PLAIN, body: { apiKey: 'hacked123' } })).status === 401);

  // ---------- 3. 作用域 ----------
  section('3. 作用域（站点 / 模型白名单）');
  const chat = (model) => ({ method: 'POST', key: PLAIN, body: { model, messages: [{ role: 'user', content: 'hi' }] } });
  const rSite = await call('/v1/chat/completions', chat('cn-cli/deepseek-v4-pro'));
  chk('越权站点被拒 403', rSite.status === 403, `实际 ${rSite.status}`);
  chk('越权站点给出 site_not_allowed', rSite.json?.error?.type === 'site_not_allowed', JSON.stringify(rSite.json));
  const rModel = await call('/v1/chat/completions', chat('intl-cli/glm-5.3'));
  chk('越权模型被拒 403', rModel.status === 403, `实际 ${rModel.status}`);
  chk('越权模型给出 model_not_allowed', rModel.json?.error?.type === 'model_not_allowed');
  const rOk = await call('/v1/chat/completions', chat('intl-cli/deepseek-v4.1-flash'));
  chk('允许的模型通过作用域（非 403）', rOk.status !== 403, `实际 ${rOk.status}`);

  // ---------- 4. 限流 ----------
  section('4. 限流（2 RPM）');
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await call('/v1/chat/completions', chat('intl-cli/deepseek-v4.1-flash'))).status);
  console.log(`    连续 4 次：${codes.join(', ')}`);
  chk('超出 RPM 返回 429', codes.includes(429));

  // ---------- 5. Prometheus 指标 ----------
  section('5. Prometheus 指标');
  const metrics = await call('/metrics', { raw: true });
  chk('指标接口 200', metrics.status === 200);
  chk('Content-Type 为 prometheus 文本', /text\/plain/.test(metrics.headers.get('content-type') || ''));
  for (const [name, pattern] of [
    ['workbuddy_up', /workbuddy_up 1/],
    ['调用计数', /workbuddy_requests_total\{status="ok"\}/],
    ['token 计数', /workbuddy_tokens_total\{kind="prompt"\}/],
    ['credit 计数', /workbuddy_credit_used_total/],
    ['延迟直方图', /workbuddy_request_duration_ms_bucket\{le="/],
    ['延迟分位', /workbuddy_latency_p99_ms/],
    ['按密钥统计', /workbuddy_key_requests_total\{key="/],
    ['站点登录状态', /workbuddy_site_logged_in\{site="/],
    ['版本信息', /workbuddy_build_info\{version="/],
  ]) chk(`指标含 ${name}`, pattern.test(metrics.text));
  chk('指标需鉴权', (await call('/metrics', { key: '' })).status === 401);

  // ---------- 6. 审计 ----------
  section('6. 访问审计（去重 + 状态码准确）');
  const audit = await call('/console/api/audit?limit=100');
  const rows = audit.json?.data || [];
  chk('审计有记录', rows.length > 0, `${rows.length} 条`);
  chk('限流已入审计且状态码为 429', rows.some((r) => r.reason === 'rate_limited' && r.status === 429));
  chk('越权站点已入审计且状态码为 403', rows.some((r) => r.reason === 'site_not_allowed' && r.status === 403));
  chk('审计记录带密钥名', rows.some((r) => r.keyName === '冒烟密钥'));
  chk('无「异常却记 200」条目', !rows.some((r) => r.status === 200 && r.reason === 'exception'));
  chk('审计落盘 audit.log', fs.existsSync(path.join(DATA, 'audit.log')));
  // 同一请求只记一条：统计某个具体 path 在极短窗口内的重复
  const chatRows = rows.filter((r) => r.path === '/v1/chat/completions');
  const msSum = chatRows.reduce((n, r) => n + (r.ms || 0), 0);
  chk('审计无重复计数（同请求单条）', chatRows.length <= 8, `${chatRows.length} 条`);

  // ---------- 7. 积分组成 ----------
  section('7. 积分组成与到期时间接口');
  const credit = await call('/console/api/credit?inactive=1');
  chk('积分接口 200', credit.status === 200);
  const cl = credit.json?.data || [];
  chk('返回全部站点', cl.length >= 3, `${cl.length} 个`);
  chk('每个站点带 parts 字段', cl.every((s) => Array.isArray(s.parts)));
  chk('每个站点带 packages 字段', cl.every((s) => Array.isArray(s.packages)));
  chk('带到期人话描述字段', cl.some((s) => s.lastExpiryHuman !== undefined));
  // 已登录站点的积分组成应可解析（离线时可能失败，故只校验结构不校验数值）
  const logged = cl.filter((s) => s.logged_in && !s.error);
  if (logged.length) {
    chk('已登录站点有剩余积分数值', logged.every((s) => typeof s.remain === 'number'));
    chk('parts 含占比 share', logged.some((s) => s.parts.some((p) => typeof p.share === 'number')));
  } else {
    console.log('    （当前无已登录站点，跳过数值校验）');
  }

  // ---------- 8. 账号备注名 ----------
  section('8. 账号备注名（区分同组账号）');
  const LABEL = '我的主力号 ⭐';
  const setLabel = await call('/console/api/site/account-label', { method: 'POST', body: { site: 'cn-cli', accountLabel: LABEL } });
  chk('保存备注名（含中文与 emoji）', setLabel.json?.account_label === LABEL, JSON.stringify(setLabel.json));
  const st = await call('/console/api/state');
  const site0 = (st.json?.sites || []).find((s) => s.site === 'cn-cli');
  chk('/state 返回备注名', site0?.account_label === LABEL);
  chk('/state 含账号昵称字段', 'nickname' in (site0 || {}));
  chk('/state 含完整 UID 字段', 'uid' in (site0 || {}));
  chk('/status 返回备注名', ((await call('/status')).json?.sites || []).find((s) => s.site === 'cn-cli')?.account_label === LABEL);
  chk('/credit 返回备注名', ((await call('/console/api/credit')).json?.data || []).find((s) => s.site === 'cn-cli')?.account_label === LABEL);
  await call('/console/api/site/account-label', { method: 'POST', body: { site: 'cn-cli', accountLabel: '' } });
  chk('清空备注名后不再返回', !((await call('/console/api/state')).json?.sites || []).find((s) => s.site === 'cn-cli')?.account_label);
  chk('未知站点被拒', (await call('/console/api/site/account-label', { method: 'POST', body: { site: 'nope', accountLabel: 'x' } })).status === 400);

  // ---------- 9. 主密钥在线修改 ----------
  section('9. 主密钥在线修改');
  chk('少于 4 位被拒', (await call('/console/api/api-key', { method: 'POST', body: { apiKey: 'ab' } })).status === 400);
  chk('含空格被拒', (await call('/console/api/api-key', { method: 'POST', body: { apiKey: 'ab cd' } })).status === 400);
  const gen = await call('/console/api/api-key/generate');
  chk('可生成随机密钥建议', typeof gen.json?.suggestion === 'string' && gen.json.suggestion.length >= 20);
  const NEW = 'smoke-new-key-' + Date.now();
  const chg = await call('/console/api/api-key', { method: 'POST', body: { apiKey: NEW } });
  chk('修改主密钥成功', chg.json?.api_key === NEW, JSON.stringify(chg.json));
  chk('新密钥立即可用', (await call('/status', { key: NEW })).status === 200);
  chk('旧密钥立即失效', (await call('/status', { key: MASTER })).status === 401);
  const restore = await call('/console/api/api-key', { method: 'POST', key: NEW, body: { apiKey: MASTER } });
  chk('恢复原密钥', restore.json?.api_key === MASTER);
  chk('原密钥恢复可用', (await call('/status')).status === 200);
  chk('主密钥已落盘 config.json', JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8')).apiKey === MASTER);

  // ---------- 10. 用量 / 监控 / 导出 ----------
  section('10. 用量、监控与导出');
  // usage.json 写入有 3 秒节流，等落盘后再校验
  await sleep(3500);
  const usage = await call('/console/api/usage');
  chk('用量快照 200', usage.status === 200, `实际 ${usage.status}`);
  chk('用量含延迟分位', usage.json?.totalLatency && 'p95Ms' in usage.json.totalLatency);
  chk('用量含小时分布', Array.isArray(usage.json?.hours) && usage.json.hours.length === 24);
  chk('用量含按站点', Array.isArray(usage.json?.bySite));
  chk('用量含按密钥', Array.isArray(usage.json?.byKey));
  chk('用量含按模型', Array.isArray(usage.json?.byModel));
  chk('已记录到调用（含被拒绝的）', (usage.json?.totals?.calls || 0) > 0, `calls=${usage.json?.totals?.calls}`);
  const mon = await call('/console/api/monitor');
  chk('监控总览 200', mon.status === 200);
  chk('监控含内存占用', typeof mon.json?.rss_bytes === 'number');
  chk('监控含运行时在途统计', mon.json?.rates !== undefined);
  const csv = await call('/console/api/usage/export', { raw: true });
  chk('CSV 导出 200', csv.status === 200);
  chk('CSV 带下载文件名', /attachment/.test(csv.headers.get('content-disposition') || ''));
  chk('CSV 首行为表头', csv.text.replace(/^\uFEFF/, '').startsWith('date,calls,errors'));

  // ---------- 11. data 目录布局 ----------
  section('11. data/ 目录布局与隔离');
  for (const f of ['config.json', 'keys.json', 'usage.json', 'audit.log']) {
    chk(`data/ 内含 ${f}`, fs.existsSync(path.join(DATA, f)));
  }
  const rootFiles = fs.readdirSync(import.meta.dirname);
  for (const f of ['config.json', 'keys.json', 'usage.json', 'checkin.json']) {
    chk(`项目根目录无残留 ${f}`, !rootFiles.includes(f));
  }
  chk('控制台页面可访问', (await fetch(BASE + '/console')).status === 200);
  const html = await (await fetch(BASE + '/console')).text();
  chk('控制台注入会话令牌', /__WB_TOKEN__/.test(html));
  chk('控制台为苹果风格（明暗主题变量）', /data-theme/.test(html) && /backdrop-filter/.test(html));
  chk('控制台含积分页签', /tab-credit/.test(html));
  chk('控制台含访问控制页签', /tab-access/.test(html));
  chk('控制台含主密钥修改入口', /saveApiKey/.test(html));

  // ---------- 12. 收尾 ----------
  section('12. 优雅停止');
  const stop = await call('/admin/shutdown', { method: 'POST' });
  chk('主密钥可停服', stop.status === 200);
  await sleep(600);
  let down = false;
  try { await fetch(BASE + '/health'); } catch { down = true; }
  chk('停服后端口不再响应', down);
} catch (e) {
  console.error('\n冒烟测试异常：', e);
  fail++;
  failures.push('异常：' + e.message);
}

console.log(`\n\x1b[1m================ 结果：通过 ${pass}，失败 ${fail} ================\x1b[0m`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  console.log('\n--- 服务日志尾部 ---');
  console.log(serverLog.split('\n').slice(-25).join('\n'));
}
if (KEEP) console.log(`\n数据目录保留在：${DATA}`);
process.exit(fail ? 1 : 0);