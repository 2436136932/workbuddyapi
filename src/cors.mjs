// 浏览器来源（Origin）判定：只放行本机来源与配置白名单，避免任意网页借用本机代理
// （DNS rebinding / 白嫖额度）。非浏览器客户端（SDK/CLI）不带 Origin，照常放行。
const LOCAL_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/**
 * @param {object} cfg 配置（读取 cfg.host / cfg.port / cfg.cors.allowOrigins）
 * @param {{headers?: {origin?: string}}} req
 * @returns {{origin: string|null, allowed: boolean}}
 */
export function resolveCorsOrigin(cfg, req) {
  const origin = req?.headers?.origin;
  if (!origin || origin === 'null') return { origin: null, allowed: true };
  if (LOCAL_ORIGIN_RE.test(origin)) return { origin, allowed: true };
  // 配置里显式声明的自身来源（改了 host/port 时控制台自用不被拦）
  const selfOrigins = [`http://${cfg.host}:${cfg.port}`, `https://${cfg.host}:${cfg.port}`];
  const extra = cfg.cors?.allowOrigins || [];
  const allow = new Set([...selfOrigins, ...(Array.isArray(extra) ? extra : [])]);
  if (allow.has(origin)) return { origin, allowed: true };
  return { origin, allowed: false };
}
