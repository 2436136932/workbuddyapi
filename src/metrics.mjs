// Prometheus 指标导出（文本格式 0.0.4）：/metrics 端点用。
// 数据来源：src/usage.mjs 的聚合快照 + 进程运行时信息 + 访问控制运行时状态。
// 零依赖，手写文本格式，避免为几个指标引入 prom-client。
import { usageSnapshot } from './usage.mjs';
import { siteKeys } from './config.mjs';
import { isLoggedIn } from './auth.mjs';
import { rateSnapshot } from './access.mjs';

/** Prometheus 标签值转义（反斜杠、引号、换行）。 */
function esc(v) {
  return String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labels(obj) {
  const parts = Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}="${esc(v)}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}

/**
 * 生成 Prometheus 文本指标。
 * @param {object} ctx { cfg, startedAt, version, extra }
 */
export function renderMetrics({ cfg, startedAt = Date.now(), version = '', extra = {} } = {}) {
  const u = usageSnapshot(7);
  const lines = [];
  const emit = (name, help, type, samples) => {
    if (!samples.length) return;
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    for (const s of samples) lines.push(`${name}${s.labels || ''} ${s.value}`);
  };

  // ---- 服务自身 ----
  emit('workbuddy_up', '反代服务是否在运行（始终为 1）', 'gauge', [{ value: 1 }]);
  emit('workbuddy_uptime_seconds', '服务已运行秒数', 'gauge', [
    { value: Math.floor((Date.now() - startedAt) / 1000) },
  ]);
  if (version) {
    lines.push('# HELP workbuddy_build_info 版本信息（值为 1）');
    lines.push('# TYPE workbuddy_build_info gauge');
    lines.push(`workbuddy_build_info${labels({ version, node: process.version, platform: process.platform })} 1`);
  }

  // ---- 站点登录状态 ----
  emit('workbuddy_site_logged_in', '站点登录状态（1=已登录）', 'gauge',
    siteKeys(cfg).map((s) => ({ labels: labels({ site: s }), value: isLoggedIn(s) ? 1 : 0 })));

  // ---- 调用计数 ----
  emit('workbuddy_requests_total', '累计调用次数', 'counter', [
    { labels: labels({ status: 'ok' }), value: u.totals.calls - u.totals.errors },
    { labels: labels({ status: 'error' }), value: u.totals.errors },
  ]);
  emit('workbuddy_tokens_total', '累计 token 数', 'counter', [
    { labels: labels({ kind: 'prompt' }), value: u.totals.promptTokens },
    { labels: labels({ kind: 'completion' }), value: u.totals.completionTokens },
  ]);
  emit('workbuddy_credit_used_total', '累计消耗 credit', 'counter', [{ value: u.totals.credit }]);

  // ---- 按模型 ----
  emit('workbuddy_model_requests_total', '按模型的累计调用次数', 'counter',
    u.byModel.map((m) => ({ labels: labels({ model: m.model, site: m.site }), value: m.calls })));
  emit('workbuddy_model_credit_used_total', '按模型的累计 credit 消耗', 'counter',
    u.byModel.map((m) => ({ labels: labels({ model: m.model, site: m.site }), value: m.credit })));
  emit('workbuddy_model_errors_total', '按模型的累计失败次数', 'counter',
    u.byModel.filter((m) => m.errors > 0).map((m) => ({ labels: labels({ model: m.model, site: m.site }), value: m.errors })));

  // ---- 按站点 ----
  emit('workbuddy_site_requests_total', '按站点的累计调用次数', 'counter',
    u.bySite.map((s) => ({ labels: labels({ site: s.site }), value: s.calls })));
  emit('workbuddy_site_credit_used_total', '按站点的累计 credit 消耗', 'counter',
    u.bySite.map((s) => ({ labels: labels({ site: s.site }), value: s.credit })));

  // ---- 按访问密钥 ----
  emit('workbuddy_key_requests_total', '按访问密钥的累计调用次数', 'counter',
    u.byKey.map((k) => ({ labels: labels({ key: k.name || k.keyId }), value: k.calls })));
  emit('workbuddy_key_credit_used_total', '按访问密钥的累计 credit 消耗', 'counter',
    u.byKey.map((k) => ({ labels: labels({ key: k.name || k.keyId }), value: k.credit })));

  // ---- 延迟直方图（按模型）----
  const bucketsMs = u.latencyBucketsMs || [];
  lines.push('# HELP workbuddy_request_duration_ms 上游请求耗时直方图（毫秒）');
  lines.push('# TYPE workbuddy_request_duration_ms histogram');
  // 全局累计直方图
  let cum = 0;
  for (let i = 0; i < bucketsMs.length; i++) {
    cum += u.latencyBuckets?.[i] || 0;
    lines.push(`workbuddy_request_duration_ms_bucket${labels({ le: bucketsMs[i] })} ${cum}`);
  }
  cum += u.latencyBuckets?.[bucketsMs.length] || 0;
  lines.push(`workbuddy_request_duration_ms_bucket${labels({ le: '+Inf' })} ${cum}`);
  lines.push(`workbuddy_request_duration_ms_sum ${(u.totals.ms || 0)}`);
  lines.push(`workbuddy_request_duration_ms_count ${cum}`);

  // ---- 延迟分位（估算值，便于快速看板）----
  emit('workbuddy_latency_p50_ms', 'P50 延迟（毫秒）', 'gauge', [{ value: u.totalLatency?.p50Ms ?? 0 }]);
  emit('workbuddy_latency_p90_ms', 'P90 延迟（毫秒）', 'gauge', [{ value: u.totalLatency?.p90Ms ?? 0 }]);
  emit('workbuddy_latency_p95_ms', 'P95 延迟（毫秒）', 'gauge', [{ value: u.totalLatency?.p95Ms ?? 0 }]);
  emit('workbuddy_latency_p99_ms', 'P99 延迟（毫秒）', 'gauge', [{ value: u.totalLatency?.p99Ms ?? 0 }]);

  // ---- 访问控制运行时 ----
  const rates = rateSnapshot();
  emit('workbuddy_key_inflight', '当前在途请求数（按密钥）', 'gauge',
    Object.entries(rates).map(([id, v]) => ({ labels: labels({ key: id.slice(0, 8) }), value: v.inflight })));
  emit('workbuddy_key_daily_calls', '当日调用次数（按密钥）', 'gauge',
    Object.entries(rates).map(([id, v]) => ({ labels: labels({ key: id.slice(0, 8) }), value: v.calls })));

  // ---- 自定义指标（扩展点）----
  for (const [name, samples] of Object.entries(extra || {})) {
    emit(name, 'custom metric', 'gauge', samples);
  }

  return lines.join('\n') + '\n';
}