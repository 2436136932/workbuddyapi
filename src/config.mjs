// 配置与路径：所有文件（配置、凭证、统计、日志）一律限定在本项目目录内，绝不读写项目外文件。
//
// 目录约定（v1.2 起）：所有运行时数据统一收进 `data/`，项目根目录只保留代码与文档。
//   data/config.json          主配置（可被环境变量覆盖）
//   data/auth.<站点>.json      各站点 / 账号槽位凭证
//   data/keys.json            访问密钥（多密钥、哈希存储、作用域与限流）
//   data/usage.json           用量统计
//   data/checkin.json         签到记录与自动签到开关
//   data/audit.log            访问审计（JSONL）
//   data/server.log 等        运行日志
// 旧版本放在根目录的同名文件会在首次启动时自动迁移进 data/（不删除用户数据，仅移动）。
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');

/** 数据目录：默认 <项目>/data，可用 WB_DATA_DIR 覆盖（便于测试或多实例隔离）。 */
export const DATA_DIR = process.env.WB_DATA_DIR
  ? path.resolve(process.env.WB_DATA_DIR)
  : path.join(ROOT, 'data');

export const paths = {
  root: ROOT,
  data: DATA_DIR,
  config: path.join(DATA_DIR, 'config.json'),
  legacyAuth: path.join(DATA_DIR, 'auth.json'), // 旧版单站点凭证（国内版），仍兼容读取
  loginState: path.join(DATA_DIR, '.login-state.json'),
  keys: path.join(DATA_DIR, 'keys.json'),
  usage: path.join(DATA_DIR, 'usage.json'),
  checkin: path.join(DATA_DIR, 'checkin.json'),
  audit: path.join(DATA_DIR, 'audit.log'),
  log: path.join(DATA_DIR, 'server.log'),
};

export function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  return DATA_DIR;
}

/**
 * 把旧版根目录下的运行时文件迁移进 data/。
 * 只在「新位置不存在」时移动，绝不覆盖已有数据；移动失败（跨卷等）退化为复制+删除。
 * @returns {string[]} 实际迁移的文件名
 */
export function migrateLegacyFiles() {
  ensureDataDir();
  if (path.resolve(DATA_DIR) === path.resolve(ROOT)) return [];
  let names = [];
  try {
    names = fs.readdirSync(ROOT);
  } catch {
    return [];
  }
  // 根目录下的运行时数据：固定名 + auth.<站点>.json + 各类日志
  const isRuntime = (n) =>
    ['config.json', 'usage.json', 'checkin.json', '.login-state.json', 'auth.json',
      'server.log', 'console.log', 'checkin.log'].includes(n)
    || /^auth\.[A-Za-z0-9][A-Za-z0-9-]{0,31}\.json$/.test(n);

  const moved = [];
  for (const name of names) {
    if (!isRuntime(name)) continue;
    const from = path.join(ROOT, name);
    const to = path.join(DATA_DIR, name);
    try {
      if (!fs.statSync(from).isFile()) continue;
    } catch {
      continue;
    }
    if (fs.existsSync(to)) continue; // 新位置已有数据：保留两者，不覆盖
    try {
      fs.renameSync(from, to);
      moved.push(name);
    } catch {
      try {
        fs.copyFileSync(from, to);
        fs.rmSync(from, { force: true });
        moved.push(name);
      } catch {
        /* 迁移失败不阻塞启动：仍可读旧位置 */
      }
    }
  }
  return moved;
}

/** 兼容读取：新位置优先，其次旧位置（迁移失败时的兜底）。 */
export function resolveDataFile(name) {
  const inData = path.join(DATA_DIR, name);
  if (fs.existsSync(inData)) return inData;
  const inRoot = path.join(ROOT, name);
  if (path.resolve(DATA_DIR) !== path.resolve(ROOT) && fs.existsSync(inRoot)) return inRoot;
  return inData;
}

/** 单个站点的凭证文件：data/auth.<site>.json（多账号即多槽位，各自一份，天然隔离）。 */
export function authPathFor(site) {
  const key = String(site || '');
  // 槽位键白名单（与 config.assertSlotKey 同规则，另兼容历史三站键名）：防路径穿越
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/.test(key)) {
    throw Object.assign(new Error(`非法站点键：${site}`), { status: 400 });
  }
  return path.join(DATA_DIR, `auth.${key}.json`);
}

// 上游站点预设：国内版与国际版协议同构，仅域名 / 身份头不同。
// 同源多账号：新增账号槽位就是完整克隆某站点的配置（apiBase 等完全一致），
// 凭证按槽位键独立存放（auth.<槽位>.json），登录/刷新/签到/额度全部按槽位键隔离。
// 约定：槽位键合法字符 ^[a-z0-9][a-z0-9-]{0,31}$（防路径穿越）；
// `cloneOf` 指向被克隆的来源站，用于控制台按组展示与删除保护。
export const SITE_PRESETS = {
  'cn-cli': {
    label: '国内版 CLI（copilot.tencent.com）',
    enabled: true,
    apiBase: 'https://copilot.tencent.com',
    billingBase: 'https://www.codebuddy.cn',
    origin: 'https://www.codebuddy.cn',
    userAgent: 'CLI/2.63.2 CodeBuddy/2.63.2',
    product: 'SaaS',
  },
  'intl-cli': {
    label: '国际版 CLI（codebuddy.ai）',
    enabled: true,
    apiBase: 'https://www.codebuddy.ai',
    billingBase: 'https://www.codebuddy.ai',
    origin: 'https://www.codebuddy.ai',
    userAgent: 'CLI/2.63.2 CodeBuddy/2.63.2',
    product: 'SaaS',
    // 国际版控制台目录接口不稳定（常 500），这里内置一份实测可用清单兜底。
    // 该清单只影响「裸模型名自动选站点」与 /v1/models 展示，不影响实际调用。
    seedModels: [
      { id: 'auto', name: 'Auto（上游自动路由）' },
      { id: 'gpt-6-astra', name: 'GPT-6 Astra（上游偶发不可用）' },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol（上游偶发不可用）' },
      { id: 'gpt-5.5', name: 'GPT-5.5' },
      { id: 'gpt-5.4', name: 'GPT-5.4' },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3-Codex' },
      { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
      { id: 'claude-opus-4.6', name: 'Claude Opus 4.6' },
      { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
      { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
      { id: 'gemini-3.1-flash-image', name: 'Gemini 3.1 Flash Image' },
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash（实测 0 扣费）' },
      { id: 'glm-5.3', name: 'GLM-5.3' },
      { id: 'glm-5.2', name: 'GLM-5.2' },
      { id: 'kimi-k3', name: 'Kimi-K3' },
      { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code' },
      { id: 'kimi-k2.6', name: 'Kimi-K2.6' },
      { id: 'kimi-k2.5', name: 'Kimi-K2.5' },
      { id: 'minimax-m3', name: 'MiniMax-M3' },
      { id: 'hy3', name: 'Hy3' },
    ],
  },
  'intl-work': {
    label: '国际版 WorkBuddy（workbuddy.ai）',
    enabled: true,
    apiBase: 'https://www.workbuddy.ai',
    billingBase: 'https://www.workbuddy.ai',
    origin: 'https://www.workbuddy.ai',
    userAgent: 'CLI/2.63.2 CodeBuddy/2.63.2',
    product: 'SaaS',
    // 登录后可自行补充实测可用的模型 ID
    seedModels: [{ id: 'auto', name: 'Auto（上游自动路由）' }],
  },
};

// 默认模型清单（config.json 缺失时的兜底；真实可用清单以 GET /v1/models 实时拉取为准）
export const DEFAULT_MODELS = [
  { id: 'hy3', name: 'Hy3' },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
  { id: 'glm-5.3', name: 'GLM-5.3' },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code' },
  { id: 'auto', name: 'Auto（上游自动路由）' },
];

export function defaultConfig() {
  return {
    host: '127.0.0.1', // 仅本机可访问，不对局域网暴露
    port: 8788,
    apiKey: '123456', // 本地 API Key（仅本机使用）；如需更安全请改成自己的随机串
    defaultSite: 'cn-cli',
    defaultModel: 'deepseek-v4-pro',
    defaultMaxTokens: 16384,
    // 上游（尤其是国际版）要求 messages 首条必须是 system，客户端没给时用这句补上
    defaultSystemPrompt: 'You are a helpful AI assistant.',
    // 出站请求体里需要剔除的字段（一般留空）
    stripFields: [],
    // 站点表：国内版 / 国际版可分别启停，也可自行新增
    sites: structuredClone(SITE_PRESETS),
    // 模型 → 站点 的显式路由（可选），例如 { "claude-4.5": "intl-cli" }
    modelRoutes: {},
    timeouts: {
      headerMs: 90000, // 上游首字节（响应头）超时
      idleMs: 300000, // 流中空闲超时
      metaMs: 20000, // 模型目录 / 额度 / 登录等元数据接口超时
    },
    // 每个站点的最大并发上游请求数（防止打爆上游限流）
    concurrency: { perSite: 8 },
    // 对可重试错误（429 / 5xx / 连接失败）的退避重试
    retry: { max: 2, baseMs: 600, maxMs: 5000 },
    // 跨站来源白名单：默认只允许本机来源（127.0.0.1 / localhost），
    // 如需让浏览器页面从别的来源访问控制台，把该来源填进来。
    cors: { allowOrigins: [] },
    models: DEFAULT_MODELS,
    modelAliases: {},
    // ---- 访问控制（v1.2）----
    access: {
      // 主密钥（apiKey）的默认策略；data/keys.json 里的密钥可各自覆盖
      master: { name: '主密钥', rpm: 0, concurrency: 0, dailyCalls: 0, dailyCredit: 0 },
      // 允许访问的来源 IP；为空表示不限制（服务默认只监听 127.0.0.1）。
      // 支持单个 IP 与 IPv4 CIDR，例如 ["127.0.0.1", "192.168.1.0/24"]
      ipAllowList: [],
      // 审计：记录每次请求（含被拒绝的），落盘 data/audit.log
      audit: { enabled: true, maxEntries: 2000, includeBody: false },
    },
    // ---- 监控（v1.2）----
    metrics: {
      enabled: true, // /metrics（Prometheus 文本格式）
      recentRequests: 200, // 内存中保留的最近请求明细条数
      latencyBucketsMs: [50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000],
    },
  };
}

/** 环境变量覆盖（部署/容器友好）：WB_* 优先于配置文件。 */
function applyEnvOverrides(cfg) {
  const env = process.env;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
  if (env.WB_HOST) cfg.host = env.WB_HOST;
  const port = num(env.WB_PORT);
  if (port !== undefined) cfg.port = port;
  if (env.WB_API_KEY !== undefined) cfg.apiKey = env.WB_API_KEY;
  if (env.WB_DEFAULT_SITE) cfg.defaultSite = env.WB_DEFAULT_SITE;
  if (env.WB_DEFAULT_MODEL) cfg.defaultModel = env.WB_DEFAULT_MODEL;
  if (env.WB_MAX_TOKENS) {
    const n = num(env.WB_MAX_TOKENS);
    if (n !== undefined) cfg.defaultMaxTokens = n;
  }
  if (env.WB_DEFAULT_SYSTEM_PROMPT) cfg.defaultSystemPrompt = env.WB_DEFAULT_SYSTEM_PROMPT;
  if (env.WB_CORS_ORIGINS) {
    cfg.cors.allowOrigins = env.WB_CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (env.WB_IP_ALLOWLIST) {
    cfg.access.ipAllowList = env.WB_IP_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (env.WB_METRICS !== undefined) cfg.metrics.enabled = !['0', 'false', 'off'].includes(String(env.WB_METRICS).toLowerCase());
  return cfg;
}

function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over)) return over ?? base;
  if (typeof base !== 'object' || base === null || typeof over !== 'object' || over === null) {
    return over === undefined ? base : over;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

/** 旧版 `upstream` 字段 → sites['cn-cli']，保证老配置继续可用。 */
function migrateLegacy(raw) {
  if (!raw.upstream || raw.sites) return {};
  const u = raw.upstream;
  return {
    sites: {
      'cn-cli': {
        apiBase: u.apiBase,
        billingBase: u.billingBase,
        origin: u.origin,
        userAgent: u.userAgent,
      },
    },
  };
}

/** 读取 data/config.json；缺失时用默认配置落盘（含随机生成的本地 API Key）。 */
export function loadConfig() {
  migrateLegacyFiles();
  const file = resolveDataFile('config.json');
  if (!fs.existsSync(file)) {
    const cfg = applyEnvOverrides(defaultConfig());
    fs.writeFileSync(paths.config, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    return cfg;
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const merged = deepMerge(defaultConfig(), migrateLegacy(raw));
  const cfg = deepMerge(merged, raw);
  delete cfg.upstream; // 已迁移到 sites
  return applyEnvOverrides(cfg);
}

export function saveConfig(cfg) {
  ensureDataDir();
  fs.writeFileSync(paths.config, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

/** 已启用且在册的站点键列表。 */
export function siteKeys(cfg) {
  return Object.keys(cfg.sites || {}).filter((k) => cfg.sites[k]?.enabled !== false);
}

export function getSite(cfg, site) {
  const s = cfg.sites?.[site];
  if (!s) throw Object.assign(new Error(`未知站点：${site}（可用：${siteKeys(cfg).join(', ')}）`), { status: 400 });
  return s;
}

/** 同源多账号（账号池）工具：槽位键格式校验，防止路径穿越。 */
export function assertSlotKey(key) {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(key || ''))) {
    throw Object.assign(new Error(`非法槽位键：${key}（只允许小写字母/数字/连字符，1–32 位）`), { status: 400 });
  }
  return String(key);
}

/** 槽位所属分组：克隆槽位的 cloneOf，否则是自身（内置三站各自成组）。 */
export function slotGroupOf(siteCfg, site) {
  return siteCfg?.cloneOf || site;
}

/** 按分组整理站点键：[{ group, keys }]，保证内置站排前面、克隆槽位跟在来源站后面。 */
export function siteGroups(cfg) {
  const keys = Object.keys(cfg.sites || {});
  const order = ['cn-cli', 'intl-cli', 'intl-work'];
  const groups = new Map();
  for (const k of keys) {
    const g = slotGroupOf(cfg.sites[k], k);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(k);
  }
  for (const list of groups.values()) list.sort((a, b) => (a === slotGroupOf(cfg.sites[a], a) ? -1 : 0) - (b === slotGroupOf(cfg.sites[b], b) ? -1 : 0) || (a < b ? -1 : 1));
  return [...groups.entries()]
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b) || (a < b ? -1 : 1))
    .map(([group, list]) => ({ group, keys: list }));
}

/** 克隆一个同源账号槽位：完整复制来源站配置（apiBase/域名/UA 等一致），label 自动编号。 */
export function cloneSiteSlot(cfg, from, key, label) {
  const src = cfg.sites?.[from];
  if (!src) throw Object.assign(new Error(`未知来源站点：${from}`), { status: 400 });
  const k = assertSlotKey(key);
  if (cfg.sites[k]) throw Object.assign(new Error(`槽位键已存在：${k}`), { status: 400 });
  const siblings = Object.keys(cfg.sites).filter((x) => slotGroupOf(cfg.sites[x], x) === slotGroupOf(src, from));
  const n = siblings.length + 1;
  cfg.sites[k] = {
    ...structuredClone(src),
    label: label?.trim() || `${src.label}（账号${n}）`,
    cloneOf: slotGroupOf(src, from),
    enabled: true,
  };
  delete cfg.sites[k].seedModels; // 克隆槽位不继承内置兜底清单，避免脏展示（登录后走真实目录）
  saveConfig(cfg);
  return { key: k, site: cfg.sites[k] };
}

/** 删除一个克隆槽位（内置三站不可删；顺带清凭证与目录缓存由调用方处理）。 */
export function removeSiteSlot(cfg, key) {
  const k = assertSlotKey(key);
  const s = cfg.sites?.[k];
  if (!s) throw Object.assign(new Error(`未知站点：${k}`), { status: 400 });
  if (!s.cloneOf) throw Object.assign(new Error(`内置站点不可删除：${k}（如需停用可设 enabled=false）`), { status: 400 });
  if (cfg.defaultSite === k) throw Object.assign(new Error(`该槽位是当前默认站点，请先切换默认站点再删除`), { status: 400 });
  delete cfg.sites[k];
  saveConfig(cfg);
  return { key: k };
}
