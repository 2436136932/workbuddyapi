// OpenAI 兼容路由：/v1/models、/v1/chat/completions（流式 + 非流式，支持工具调用）
// 多站点：请求里的 model 可写裸 ID（自动选站点），也可写 `站点/模型` 显式指定。
import { openWithRetry, aggregateFrames, classifyFrame, upstreamErrorMessage, newId, usageCredit } from './upstream.mjs';
import { resolveTarget, mergedModels, parseMultiplier } from './router.mjs';
import { recordUsage } from './usage.mjs';
import { startSSE, writeSSE, sendJson, sendError, estimateTokens } from './util.mjs';
import { requestLog, warn } from './log.mjs';

/** 帧白名单重建：剥掉上游噪声（空 content、空 tool_calls、未知字段），保证标准客户端可解析。 */
export function normalizeChunk(obj, publicModel) {
  const out = {};
  for (const k of ['id', 'object', 'created', 'model', 'system_fingerprint', 'service_tier']) {
    if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k];
  }
  if (!out.object) out.object = 'chat.completion.chunk';
  if (!out.id) out.id = newId();
  if (publicModel) out.model = publicModel;
  // 上游实际应答的模型：客户端写 auto 时上游会落到具体模型（如 glm-5.2），如实透出成 upstream_model
  if (obj.model && obj.model !== publicModel) out.upstream_model = obj.model;

  if (Array.isArray(obj.choices)) {
    out.choices = obj.choices.map((c) => {
      const delta = {};
      const d = c.delta || {};
      if (typeof d.role === 'string' && d.role) delta.role = d.role;
      if (typeof d.content === 'string' && d.content) delta.content = d.content;
      if (typeof d.reasoning_content === 'string' && d.reasoning_content) delta.reasoning_content = d.reasoning_content;
      if (typeof d.refusal === 'string' && d.refusal) delta.refusal = d.refusal;
      if (Array.isArray(d.tool_calls) && d.tool_calls.length) delta.tool_calls = d.tool_calls;
      return { index: c.index ?? 0, delta, finish_reason: c.finish_reason || null };
    });
  }
  // 标准 chunk 不含 usage，仅在上游确实给出 usage（通常是最后一帧）时才带上，避免严格客户端报错
  if (obj.usage !== undefined && obj.usage !== null) out.usage = obj.usage;
  return out;
}

export async function handleChatCompletions(ctx) {
  const { cfg, res, body, signal } = ctx;
  const target = await resolveTarget(cfg, body.model);
  const { site, model } = target;
  const publicModel = target.requested;
  const wantsStream = body.stream === true;
  const started = Date.now();
  let ttfb = null;
  let tools = 0;
  let contentChars = 0;

  const upstreamBody = { ...body, model };
  if (upstreamBody.max_tokens === undefined && upstreamBody.max_completion_tokens === undefined) {
    upstreamBody.max_tokens = cfg.defaultMaxTokens;
  }

  const up = await openWithRetry(cfg, site, upstreamBody, { signal });
  if (!up.ok) {
    requestLog({ site, model, mode: wantsStream ? 'stream' : 'json', status: up.status, ms: Date.now() - started, note: 'upstream_reject' });
    return sendError(res, up.status, upstreamErrorMessage(up.status, up.text, site));
  }

  if (wantsStream) {
    startSSE(res, { 'X-Service': 'workbuddy-proxy', 'X-Upstream-Site': site });
    let valid = 0;
    let finished = false;
    let upstreamUsage = null;
    let upstreamCredit = 0;
    let upstreamModel = null; // 上游实际应答的模型（auto 会被上游落到具体模型）
    try {
      for await (const payload of up.frames) {
        const parsed = classifyFrame(payload);
        if (parsed.kind === 'error') {
          await writeSSE(res, JSON.stringify({ error: { message: parsed.message, type: 'upstream_error' } }));
          break;
        }
        if (parsed.kind !== 'chunk') continue;
        if (parsed.obj.usage) upstreamUsage = parsed.obj.usage;
        upstreamCredit = usageCredit(parsed.obj.usage, parsed.obj) || upstreamCredit;
        if (parsed.obj.model) upstreamModel = parsed.obj.model;
        if (parsed.obj.choices?.[0]?.delta?.tool_calls) tools++;
        if (ttfb === null) ttfb = Date.now() - started;
        valid++;
        if (parsed.obj.choices?.[0]?.delta?.content) contentChars += parsed.obj.choices[0].delta.content.length;
        await writeSSE(res, JSON.stringify(normalizeChunk(parsed.obj, publicModel)));
      }
      if (valid === 0) {
        await writeSSE(res, JSON.stringify({ error: { message: '上游返回空流', type: 'upstream_error' } }));
      }
      finished = true;
      await writeSSE(res, '[DONE]');
    } finally {
      up.close();
      if (!res.writableEnded) res.end();
      requestLog({
        site,
        model,
        mode: 'stream',
        status: finished ? 200 : 499,
        ttfb_ms: ttfb ?? '-',
        ms: Date.now() - started,
        frames: valid,
        real_model: upstreamModel,
      });
      recordUsage({
        site,
        model,
        mode: 'stream',
        status: finished ? 200 : 499,
        promptTokens: upstreamUsage?.prompt_tokens ?? estimateTokens(JSON.stringify(body.messages || [])),
        completionTokens: upstreamUsage?.completion_tokens ?? estimateTokens('x'.repeat(contentChars)),
        credit: upstreamCredit,
        ms: Date.now() - started,
        tools,
        realModel: upstreamModel,
      });
    }
    return;
  }

  // 非流式：聚合上游 SSE 后一次性返回
  let agg;
  try {
    agg = await aggregateFrames(up.frames);
  } catch (e) {
    requestLog({ site, model, mode: 'json', status: e.status || 502, ms: Date.now() - started, note: 'aggregate_failed' });
    return sendError(res, e.status || 502, e.message);
  } finally {
    up.close();
  }

  // 兜底：客户端 max_tokens 太小（思考型模型把预算全用在思考上）导致空回答时，放大预算重试一次
  const askedMax = Number(body.max_tokens ?? body.max_completion_tokens ?? 0);
  const emptyAnswer = !agg.content && agg.toolCallList.length === 0;
  if (emptyAnswer && (agg.finishReason === 'length' || agg.frames > 0) && askedMax > 0 && askedMax < 1024) {
    const bumped = { ...upstreamBody, max_tokens: Math.max(1024, askedMax * 4) };
    delete bumped.max_completion_tokens;
    warn(`[${site}] 空回答（finish=${agg.finishReason}，max_tokens=${askedMax}），放大到 ${bumped.max_tokens} 重试一次`);
    const up2 = await openWithRetry(cfg, site, bumped, { signal });
    if (up2.ok) {
      try {
        agg = await aggregateFrames(up2.frames);
      } catch {
        /* 保留原结果 */
      } finally {
        up2.close();
      }
    } else {
      up2.close?.();
    }
  }

  if (agg.frames === 0) {
    requestLog({ site, model, mode: 'json', status: 502, ms: Date.now() - started, note: 'empty_stream' });
    return sendError(res, 502, '上游返回空响应');
  }

  const message = { role: agg.role || 'assistant' };
  if (agg.content) message.content = agg.content;
  else message.content = agg.toolCallList.length ? null : '';
  if (agg.reasoning) message.reasoning_content = agg.reasoning;
  if (agg.toolCallList.length) {
    message.tool_calls = agg.toolCallList.map((tc, i) => ({
      id: tc.id || `call_${i}_${Date.now().toString(36)}`,
      type: 'function',
      function: { name: tc.function.name, arguments: tc.function.arguments || '{}' },
    }));
  }

  const usage =
    agg.usage ||
    {
      prompt_tokens: estimateTokens(JSON.stringify(body.messages || [])),
      completion_tokens: estimateTokens(agg.content),
      total_tokens: estimateTokens(JSON.stringify(body.messages || [])) + estimateTokens(agg.content),
    };

  requestLog({
    site,
    model,
    mode: 'json',
    status: 200,
    ms: Date.now() - started,
    real_model: agg.model,
    prompt: usage.prompt_tokens,
    completion: usage.completion_tokens,
    tools: agg.toolCallList.length || undefined,
  });

  recordUsage({
    site,
    model,
    mode: 'json',
    status: 200,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    credit: agg.credit || usageCredit(agg.usage),
    ms: Date.now() - started,
    tools: agg.toolCallList.length,
  });

  // 非流式没有 SSE 头，这里补上真实落点，便于客户端与排查直接看到
  res.setHeader('X-Upstream-Site', site);
  if (agg.model) res.setHeader('X-Upstream-Model', agg.model);

  sendJson(res, 200, {
    id: agg.id || newId(),
    object: 'chat.completion',
    created: agg.created || Math.floor(Date.now() / 1000),
    model: publicModel,
    // 上游真实模型：auto / 别名等虚拟 model 会被上游落到具体模型，这里如实透出
    upstream_model: agg.model && agg.model !== publicModel ? agg.model : undefined,
    choices: [{ index: 0, message, finish_reason: agg.finishReason || 'stop' }],
    usage,
  });
}

export async function handleModels(ctx) {
  const { cfg, res } = ctx;
  const merged = await mergedModels(cfg);
  const data = [];
  const seen = new Set();

  for (const [alias, targetModel] of Object.entries(cfg.modelAliases || {})) {
    if (seen.has(alias)) continue;
    seen.add(alias);
    data.push({ id: alias, object: 'model', created: 1700000000, owned_by: 'workbuddy', name: `${alias} → ${targetModel}` });
  }

  for (const m of merged) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const info = m.info || {};
    const item = {
      id: m.id,
      object: 'model',
      created: 1700000000,
      owned_by: m.site,
      name: info.name || m.id,
      site: m.site,
    };
    if (info.credits) {
      item.credits = info.credits; // 上游原始串，如 "x0.79 credits"
      const mult = parseMultiplier(info.credits);
      if (Number.isFinite(mult)) item.credits_multiplier = mult;
    }
    if (info.contextWindow) item.context_window = info.contextWindow;
    if (info.maxTokens) item.max_output_tokens = info.maxTokens;
    if (info.supportsImages) item.supports_images = true;
    if (info.supportsToolCall) item.supports_tools = true;
    if (m.aliasOf) item.alias_of = m.aliasOf;
    data.push(item);
  }

  // 目录拉取失败（未登录/接口不可用）时用配置兜底，保证客户端至少能看到可用 ID
  if (!merged.length) {
    for (const m of cfg.models || []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      data.push({ id: m.id, object: 'model', created: 1700000000, owned_by: 'workbuddy', name: m.name || m.id, site: cfg.defaultSite });
    }
  }

  // 来源如实上报：动态目录 upstream / 全部来自内置清单 seed / 两者混合 upstream+seed / 目录为空回落配置 config
  const fromSeed = merged.filter((m) => m.info?.seed).length;
  const source = !merged.length ? 'config' : fromSeed === merged.length ? 'seed' : fromSeed ? 'upstream+seed' : 'upstream';

  sendJson(res, 200, { object: 'list', data, source });
}
