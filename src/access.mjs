// 访问控制：多密钥（哈希存储）、作用域（模型/站点白名单）、限流与配额、来源 IP 白名单、审计日志。
//
// 设计要点：
//   - 明文密钥只在创建时返回一次，落盘 data/keys.json 只存 sha256 哈希（防配置文件泄露即失守）
//   - 主密钥（config.apiKey）始终可用，作为「超级密钥」，不写入 keys.json
//   - 每个密钥可限制：模型白名单、站点白名单、RPM、并发、每日调用数 / credit 配额
//   - 审计落盘 data/audit.log（JSONL，追加写），内存保留最近 N 条供控制台查询
import crypto from 'node:crypto';
import fs from 'node:fs';
import { paths, ensureDataDir } from './config.mjs';
import { warn } from './log.mjs';

const KEY_PREFIX = 'wb-';
const MEM_AUDIT_MAX = 2000;

let keys = null; // 懒加载：{ version, keys: [{ id, name, hash, ... }] }
let auditBuffer = []; // 内存审计环形缓冲
let auditSeq = 0;

// ---------------- 密钥存取 ----------------

function emptyStore() {
  return { version: 1, keys: [] };
}

function loadKeys() {
  if (keys) return keys;
  try {
    const raw = JSON.parse(fs.readFileSync(paths.keys, 'utf8'));
    keys = raw && Array.isArray(raw.keys) ? raw : emptyStore();
  } catch {
    keys = emptyStore();
  }
  return keys;
}

function saveKeys() {
  ensureDataDir();
  fs.writeFileSync(paths.keys, JSON.stringify(keys, null, 2) + '\n', 'utf8');
}

/** 重新从磁盘读取（多进程/手工编辑后调用）。 */
export function reloadKeys() {
  keys = null;
  return loadKeys();
}

export function hashKey(plain) {
  return crypto.createHash('sha256').update(String(plain)).digest('hex');
}

/** 生成一个新的明文密钥（只在创建时返回一次）。 */
export function generateKey() {
  return KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
}

/** 对外展示用的掩码（列表接口用，绝不回传明文）。 */
export function maskKey(id) {
  return id ? `${id.slice(0, 8)}…${id.slice(-4)}` : '';
}

/** 密钥列表（不含哈希，供控制台展示）。 */
export function listKeys() {
  const store = loadKeys();
  return store.keys.map((k) => ({
    id: k.id,
    name: k.name,
    enabled: k.enabled !== false,
    created_at: k.createdAt,
    last_used_at: k.lastUsedAt || null,
    models: k.models || [],
    sites: k.sites || [],
    rpm: k.rpm || 0,
    concurrency: k.concurrency || 0,
    dailyCalls: k.dailyCalls || 0,
    dailyCredit: k.dailyCredit || 0,
    note: k.note || '',
    masked: maskKey(k.id),
  }));
}

/**
 * 新建密钥。
 * @returns {{id:string, plain:string, key:object}} plain 只在此处返回一次
 */
export function createKey({ name, models, sites, rpm, concurrency, dailyCalls, dailyCredit, note } = {}) {
  const store = loadKeys();
  const plain = generateKey();
  const id = hashKey(plain);
  if (store.keys.some((k) => k.id === id)) return createKey({ name, models, sites, rpm, concurrency, dailyCalls, dailyCredit, note });
  const key = {
    id,
    name: String(name || '').trim() || `密钥 ${store.keys.length + 1}`,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    models: normList(models),
    sites: normList(sites),
    rpm: numOr0(rpm),
    concurrency: numOr0(concurrency),
    dailyCalls: numOr0(dailyCalls),
    dailyCredit: numOr0(dailyCredit),
    note: String(note || ''),
  };
  store.keys.push(key);
  saveKeys();
  return { id, plain, key: { ...key, masked: maskKey(id) } };
}

function normList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v).split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
}

function numOr0(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 修改密钥（id 不变；可轮换 name/限制/启停）。 */
export function updateKey(id, patch = {}) {
  const store = loadKeys();
  const k = store.keys.find((x) => x.id === id);
  if (!k) throw Object.assign(new Error('密钥不存在'), { status: 404 });
  if (patch.name !== undefined) k.name = String(patch.name).trim() || k.name;
  if (patch.enabled !== undefined) k.enabled = Boolean(patch.enabled);
  if (patch.models !== undefined) k.models = normList(patch.models);
  if (patch.sites !== undefined) k.sites = normList(patch.sites);
  if (patch.rpm !== undefined) k.rpm = numOr0(patch.rpm);
  if (patch.concurrency !== undefined) k.concurrency = numOr0(patch.concurrency);
  if (patch.dailyCalls !== undefined) k.dailyCalls = numOr0(patch.dailyCalls);
  if (patch.dailyCredit !== undefined) k.dailyCredit = numOr0(patch.dailyCredit);
  if (patch.note !== undefined) k.note = String(patch.note);
  saveKeys();
  return { ...k, masked: maskKey(k.id) };
}

export function removeKey(id) {
  const store = loadKeys();
  const i = store.keys.findIndex((x) => x.id === id);
  if (i < 0) throw Object.assign(new Error('密钥不存在'), { status: 404 });
  const [removed] = store.keys.splice(i, 1);
  saveKeys();
  return { id: removed.id, name: removed.name };
}

// ---------------- 来源 IP 白名单 ----------------

/** 解析 IPv4 为 32 位整数；非 IPv4 返回 null。 */
function ipv4ToInt(ip) {
  const parts = String(ip).trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n * 256) + v;
  }
  return n >>> 0;
}

/**
 * 判断来源 IP 是否被允许。
 * 支持精确匹配、IPv4 CIDR（如 192.168.1.0/24）、通配 `*`。
 * 列表为空 → 不限制（服务默认只监听 127.0.0.1）。
 */
export function isIpAllowed(ip, allowList) {
  const list = Array.isArray(allowList) ? allowList.filter(Boolean) : [];
  if (!list.length) return true;
  // 去掉 IPv6 映射前缀，统一按 IPv4 比较
  let addr = String(ip || '').trim();
  if (addr.startsWith('::ffff:')) addr = addr.slice(7);
  if (addr === '::1') addr = '127.0.0.1';
  const addrInt = ipv4ToInt(addr);
  for (const rule of list) {
    const r = String(rule).trim();
    if (!r) continue;
    if (r === '*') return true;
    if (r.includes('/')) {
      const [base, bitsRaw] = r.split('/');
      const bits = Number(bitsRaw);
      const baseInt = ipv4ToInt(base);
      if (baseInt === null || addrInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if ((addrInt & mask) === (baseInt & mask)) return true;
      continue;
    }
    if (r === addr) return true;
    if (r === 'localhost' && (addr === '127.0.0.1' || addr === '::1')) return true;
  }
  return false;
}

// ---------------- 限流与配额 ----------------

const buckets = new Map(); // keyId → { tokens, last }（令牌桶，按分钟补充）
const inflight = new Map(); // keyId → 当前并发
const dailyCounters = new Map(); // `${keyId}|${day}` → { calls, credit }

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 限流检查（RPM + 并发 + 每日调用/credit 配额）。
 * @returns {{ok:true}|{ok:false, status:number, message:string, code:string}}
 */
export function checkRate({ keyId, rpm = 0, concurrency = 0, dailyCalls = 0, dailyCredit = 0, creditUsedToday = 0 }) {
  const now = Date.now();
  if (rpm > 0) {
    let b = buckets.get(keyId);
    if (!b) {
      b = { tokens: rpm, last: now };
      buckets.set(keyId, b);
    }
    // 按分钟线性补充令牌
    const elapsed = now - b.last;
    if (elapsed > 0) {
      b.tokens = Math.min(rpm, b.tokens + (elapsed / 60000) * rpm);
      b.last = now;
    }
    if (b.tokens < 1) {
      const waitMs = Math.ceil(((1 - b.tokens) / rpm) * 60000);
      return {
        ok: false, status: 429, code: 'rate_limited',
        message: `超出该密钥的每分钟请求上限（${rpm} RPM），请 ${Math.max(1, Math.ceil(waitMs / 1000))} 秒后重试`,
      };
    }
    b.tokens -= 1;
  }
  if (concurrency > 0 && (inflight.get(keyId) || 0) >= concurrency) {
    return {
      ok: false, status: 429, code: 'concurrency_limited',
      message: `超出该密钥的并发上限（${concurrency}），请稍后重试`,
    };
  }
  const day = todayKey();
  const counter = dailyCounters.get(`${keyId}|${day}`) || { calls: 0, credit: 0 };
  if (dailyCalls > 0 && counter.calls >= dailyCalls) {
    return {
      ok: false, status: 429, code: 'daily_calls_exceeded',
      message: `已达该密钥的每日调用上限（${dailyCalls} 次），明日重置`,
    };
  }
  if (dailyCredit > 0 && creditUsedToday >= dailyCredit) {
    return {
      ok: false, status: 429, code: 'daily_credit_exceeded',
      message: `已达该密钥的每日 credit 上限（${dailyCredit}），明日重置`,
    };
  }
  return { ok: true };
}

/** 请求开始：占用一个并发名额，并累计一次调用。 */
export function acquireSlot(keyId) {
  inflight.set(keyId, (inflight.get(keyId) || 0) + 1);
  const day = todayKey();
  const k = `${keyId}|${day}`;
  const c = dailyCounters.get(k) || { calls: 0, credit: 0 };
  c.calls += 1;
  dailyCounters.set(k, c);
}

/** 请求结束：释放并发名额，并计入 credit 消耗。 */
export function releaseSlot(keyId, credit = 0) {
  const cur = (inflight.get(keyId) || 0) - 1;
  if (cur <= 0) inflight.delete(keyId);
  else inflight.set(keyId, cur);
  if (credit > 0) {
    const day = todayKey();
    const k = `${keyId}|${day}`;
    const c = dailyCounters.get(k) || { calls: 0, credit: 0 };
    c.credit += Number(credit) || 0;
    dailyCounters.set(k, c);
  }
}

/** 当日已消耗 credit（用于配额判定）。 */
export function creditUsedToday(keyId) {
  const c = dailyCounters.get(`${keyId}|${todayKey()}`);
  return c ? c.credit : 0;
}

/** 运行时状态（控制台展示用）。 */
export function rateSnapshot() {
  const day = todayKey();
  const out = {};
  for (const [k, v] of dailyCounters) {
    const [keyId, d] = k.split('|');
    if (d !== day) continue;
    out[keyId] = { calls: v.calls, credit: v.credit, inflight: inflight.get(keyId) || 0 };
  }
  return out;
}

// ---------------- 审计 ----------------

/** 记录一条审计（落盘 JSONL + 内存缓冲）。 */
export function audit(entry, cfg) {
  const max = cfg?.access?.audit?.maxEntries ?? MEM_AUDIT_MAX;
  const rec = { seq: ++auditSeq, at: new Date().toISOString(), ...entry };
  auditBuffer.push(rec);
  if (auditBuffer.length > max) auditBuffer.splice(0, auditBuffer.length - max);
  if (cfg?.access?.audit?.enabled !== false) {
    try {
      ensureDataDir();
      fs.appendFileSync(paths.audit, JSON.stringify(rec) + '\n', 'utf8');
    } catch (e) {
      warn('审计日志写入失败：', e.message);
    }
  }
  return rec;
}

/** 最近审计（可按 keyId / 仅失败 / 仅拒绝 过滤）。 */
export function recentAudit({ limit = 200, keyId = null, onlyErrors = false, onlyDenied = false } = {}) {
  let list = auditBuffer;
  if (keyId) list = list.filter((r) => r.keyId === keyId);
  if (onlyErrors) list = list.filter((r) => r.status >= 400);
  if (onlyDenied) list = list.filter((r) => r.denied);
  return list.slice(-Math.max(1, Math.min(2000, limit))).reverse();
}

/** 清空内存审计缓冲（磁盘 audit.log 不动）。 */
export function clearAuditBuffer() {
  auditBuffer = [];
}

/** 从磁盘读取审计（用于重启后回看；只读尾部若干行）。 */
export function tailAuditFile(limit = 200) {
  try {
    const text = fs.readFileSync(paths.audit, 'utf8');
    return text.trim().split('\n').slice(-limit).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean).reverse();
  } catch {
    return [];
  }
}

// ---------------- 认证主体解析 ----------------

/**
 * 解析请求携带的密钥 → 认证主体。
 * 主密钥（config.apiKey）优先匹配，返回 scope='master' 的全权主体。
 * @returns {{ok:true, principal:object}|{ok:false, reason:string}}
 */
export function resolvePrincipal(cfg, plainKey) {
  const provided = String(plainKey || '').trim();
  if (!provided) return { ok: false, reason: 'missing' };

  if (cfg.apiKey && provided === cfg.apiKey) {
    const m = cfg.access?.master || {};
    return {
      ok: true,
      principal: {
        keyId: 'master',
        name: m.name || '主密钥',
        scope: 'master',
        models: [], sites: [],
        rpm: numOr0(m.rpm),
        concurrency: numOr0(m.concurrency),
        dailyCalls: numOr0(m.dailyCalls),
        dailyCredit: numOr0(m.dailyCredit),
      },
    };
  }

  const store = loadKeys();
  const id = hashKey(provided);
  const k = store.keys.find((x) => x.id === id);
  if (!k) return { ok: false, reason: 'invalid' };
  if (k.enabled === false) return { ok: false, reason: 'disabled' };

  k.lastUsedAt = new Date().toISOString();
  // lastUsedAt 变化不必每次落盘：节流到 60s
  if (!k._lastPersist || Date.now() - k._lastPersist > 60000) {
    k._lastPersist = Date.now();
    try { saveKeys(); } catch { /* 落盘失败不影响请求 */ }
  }

  return {
    ok: true,
    principal: {
      keyId: k.id,
      name: k.name,
      scope: 'key',
      models: k.models || [],
      sites: k.sites || [],
      rpm: numOr0(k.rpm),
      concurrency: numOr0(k.concurrency),
      dailyCalls: numOr0(k.dailyCalls),
      dailyCredit: numOr0(k.dailyCredit),
    },
  };
}

/**
 * 作用域校验：该密钥是否允许访问某模型 / 站点。
 * 支持精确匹配与 `*` 通配、以及 `前缀*` 通配。
 */
export function scopeAllows(list, value) {
  if (!Array.isArray(list) || !list.length) return true; // 空 = 不限制
  const v = String(value || '');
  for (const raw of list) {
    const p = String(raw).trim();
    if (!p) continue;
    if (p === '*' || p === v) return true;
    if (p.endsWith('*') && v.startsWith(p.slice(0, -1))) return true;
  }
  return false;
}

/** 综合检查一个请求是否被允许（IP → 作用域 → 限流）。 */
export function authorizeRequest({ cfg, principal, ip, model, site }) {
  if (!isIpAllowed(ip, cfg.access?.ipAllowList)) {
    return { ok: false, status: 403, code: 'ip_not_allowed', message: `来源 IP ${ip} 不在允许列表内` };
  }
  if (principal.scope !== 'master') {
    if (!scopeAllows(principal.sites, site)) {
      return { ok: false, status: 403, code: 'site_not_allowed', message: `该密钥无权访问站点 ${site}` };
    }
    if (!scopeAllows(principal.models, model)) {
      return { ok: false, status: 403, code: 'model_not_allowed', message: `该密钥无权访问模型 ${model}` };
    }
  }
  const rate = checkRate({
    keyId: principal.keyId,
    rpm: principal.rpm,
    concurrency: principal.concurrency,
    dailyCalls: principal.dailyCalls,
    dailyCredit: principal.dailyCredit,
    creditUsedToday: creditUsedToday(principal.keyId),
  });
  if (!rate.ok) return rate;
  return { ok: true };
}