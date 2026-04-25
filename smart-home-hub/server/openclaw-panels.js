// server/openclaw-panels.js
// ────────────────────────────────────────────────────────────────
// 基于 openclaw.js 长连客户端，聚合出 LLM / Tool Log / Voice /
// System Summary / Nodes 五个面板的 snapshot。
//
//   - 每 5s 轮询 models.list / usage.status / voicewake.get /
//     talk.mode，缓存最新返回。首次拿到返回时打印 JSON，方便
//     对齐 shape。失败也只打一次警告，防刷屏。
//   - 订阅 session.tool 事件维护一个 50 条的 tool-log ring buffer，
//     有新条目时通过 onToolLogAppend 推给订阅者（server.js 用来
//     publish TOPICS.TOOL_LOG_APPEND）。
//   - 解析器都用多字段 fallback 以适配未知的返回 shape；解析不到
//     时降级为 '—'，不会抛错。
// ────────────────────────────────────────────────────────────────

import * as openclaw from './openclaw.js';
import {
  payloadToToolEntry,
  agentEventToTool,
  sessionMessageToTools,
  sessionToolEventToAction,
} from './tool-log-parse.js';

const POLL_MS = 5_000;
const TOOL_LOG_CAP = 50;
const RPC_TIMEOUT_MS = 3_000;
const NODE_ONLINE_WINDOW_MS = 10 * 60_000;   // 10min 内更新过就算在线

const state = {
  started: false,
  pollTimer: null,
  models: null,
  usage: null,
  voicewake: null,
  talkConfig: null,
  toolLog: [],
  toolLogListeners: new Set(),
  toolSub: null,
  agentSub: null,
  msgSub: null,
  anySub: null,
  connSub: null,
  eventSeenCount: 0,
  toolRawLoggedCount: 0,
  agentStreamLoggedCount: 0,
  sessionMsgLoggedCount: 0,
  subscribed: false,
};

// 首次调用时打印真实返回 shape，便于校正解析器
const loggedOk  = new Set();
const loggedErr = new Set();

const DEBUG_ANY_EVENT_CAP = 80;   // onAny 最多打多少条事件名/payload 摘要
const DEBUG_TOOL_RAW_CAP  = 5;    // session.tool 最多打多少条完整 raw payload
const DEBUG_AGENT_STREAM_CAP = 20;// agent 非 lifecycle 事件打多少条完整 payload
const DEBUG_SESSION_MSG_CAP  = 10;// session.message 打多少条完整 payload

// 已经看到过的 (event,stream) 组合，每种只打一次完整 dump，避免刷屏
const loggedAgentStream = new Set();

function asArr(v) { return Array.isArray(v) ? v : []; }

async function callRpc(method, params = {}) {
  try {
    const r = await openclaw.rpc(method, params, RPC_TIMEOUT_MS);
    if (!loggedOk.has(method)) {
      loggedOk.add(method);
      const dump = JSON.stringify(r);
      console.log(`[openclaw-panels] ▲ ${method} → ${dump.length > 400 ? dump.slice(0,400)+'…' : dump}`);
    }
    return r;
  } catch (e) {
    if (!loggedErr.has(method)) {
      loggedErr.add(method);
      console.warn(`[openclaw-panels] ✕ ${method}: ${e.code || ''} ${e.message}`);
    }
    return null;
  }
}

async function pollOnce() {
  if (!openclaw.isConnected()) return;
  const [models, usage, wake, config] = await Promise.all([
    callRpc('models.list'),
    callRpc('usage.status'),
    callRpc('voicewake.get'),
    callRpc('talk.config'),     // talk.mode 是 setter，需要 operator.write；talk.config 是 reader
  ]);
  if (models) state.models     = models;
  if (usage)  state.usage      = usage;
  if (wake)   state.voicewake  = wake;
  if (config) state.talkConfig = config;
}

// ── tool log ──────────────────────────────────────────────

function onSessionTool(payload) {
  if (state.toolRawLoggedCount < DEBUG_TOOL_RAW_CAP) {
    state.toolRawLoggedCount++;
    const dump = JSON.stringify(payload);
    console.log(`[openclaw-panels] ▲ session.tool raw #${state.toolRawLoggedCount} → ${dump.length > 800 ? dump.slice(0,800)+'…' : dump}`);
  }
  const r = sessionToolEventToAction(payload);
  if (state.toolRawLoggedCount <= DEBUG_TOOL_RAW_CAP) {
    console.log(`[openclaw-panels] ▲ session.tool action → ${JSON.stringify(r)}`);
  }
  if (!r) return;
  if (r.kind === 'entry') publishToolLog(r.entry);
  else if (r.kind === 'patch') {
    // latency = result.ts - update.ts（存在 _startedAt 时）
    const existing = findToolEntryById(r.patch.id);
    if (existing && existing._startedAt && r.patch._resultTs) {
      const lat = Math.max(0, r.patch._resultTs - existing._startedAt);
      applyToolPatch({ ...r.patch, latency: lat });
    } else {
      applyToolPatch(r.patch);
    }
  }
}

// 诊断用：所有进来的事件名都打一遍（有上限），方便发现 session.tool 实际叫什么
function onAnyEvent(event, payload) {
  if (event === 'connect.challenge') return;
  if (state.eventSeenCount >= DEBUG_ANY_EVENT_CAP) return;
  state.eventSeenCount++;
  const dump = payload == null ? '' : JSON.stringify(payload);
  const brief = dump.length > 200 ? dump.slice(0, 200) + '…' : dump;
  console.log(`[openclaw-panels] ▼ event #${state.eventSeenCount} ${event} ${brief}`);
}

// agent 事件：stream=lifecycle / tool / content / delta 等。
// 解析走 tool-log-parse.agentEventToTool。
function onAgentEvent(payload) {
  const stream = payload?.stream || '(nostream)';
  const tag = `agent/${stream}`;
  if (!loggedAgentStream.has(tag)) {
    loggedAgentStream.add(tag);
    const dump = JSON.stringify(payload);
    console.log(`[openclaw-panels] ☆ first ${tag} → ${dump.length > 800 ? dump.slice(0,800)+'…' : dump}`);
  }
  if (stream === 'lifecycle') return;

  if (state.agentStreamLoggedCount < DEBUG_AGENT_STREAM_CAP) {
    state.agentStreamLoggedCount++;
    const dump = JSON.stringify(payload);
    console.log(`[openclaw-panels] ▲ agent#${state.agentStreamLoggedCount} stream=${stream} → ${dump.length > 600 ? dump.slice(0,600)+'…' : dump}`);
  }

  const r = agentEventToTool(payload);
  if (!r) return;
  if (r.kind === 'entry') publishToolLog(r.entry);
  else if (r.kind === 'patch') applyToolPatch(r.patch);
}

// session.message：content 里 tool_use → append；tool_result → patch。
function onSessionMessage(payload) {
  if (state.sessionMsgLoggedCount < DEBUG_SESSION_MSG_CAP) {
    state.sessionMsgLoggedCount++;
    const dump = JSON.stringify(payload);
    console.log(`[openclaw-panels] ▲ msg#${state.sessionMsgLoggedCount} → ${dump.length > 700 ? dump.slice(0,700)+'…' : dump}`);
  }
  const { entries, patches } = sessionMessageToTools(payload);
  for (const e of entries)  publishToolLog(e);
  for (const p of patches)  applyToolPatch(p);
}

function findToolEntryById(id) {
  if (!id) return null;
  for (let i = state.toolLog.length - 1; i >= 0; i--) {
    if (state.toolLog[i].id === id) return state.toolLog[i];
  }
  return null;
}

function publishToolLog(entry) {
  if (!entry) return;
  // 同 id 已存在 → 当 patch 处理，防止前端重复渲染
  if (findToolEntryById(entry.id)) { applyToolPatch(entry); return; }
  state.toolLog.push(entry);
  while (state.toolLog.length > TOOL_LOG_CAP) state.toolLog.shift();
  for (const h of state.toolLogListeners) {
    try { h(entry); }
    catch (e) { console.error('[openclaw-panels] toolLog listener error:', e); }
  }
}

function applyToolPatch(patch) {
  if (!patch || !patch.id) return;
  const existing = findToolEntryById(patch.id);
  if (!existing) return;
  if (patch.status)  existing.status  = patch.status;
  if (patch.latency) existing.latency = patch.latency;
  if (patch.tool)    existing.tool    = patch.tool;
  if (patch.input)   existing.input   = patch.input;
  // 前端按 id 去重后会用新字段替换老行
  for (const h of state.toolLogListeners) {
    try { h(existing); }
    catch (e) { console.error('[openclaw-panels] toolLog listener error:', e); }
  }
}

// 已经订阅过的 sessionKey，避免重复订阅
const subscribedKeys = new Set();

export async function subscribeSession(sessionKey, { tag = 'init' } = {}) {
  if (!sessionKey || subscribedKeys.has(sessionKey)) return;
  subscribedKeys.add(sessionKey);

  // 两个订阅各自做：messages 拿细粒度 content block；sessions 拿生命周期/变更。
  // sessions.messages.subscribe 的字段名是 'key'（上一轮 error 反馈），
  // sessions.subscribe 的字段名是 'sessionKey'（上一轮成功的那次用的）。
  const attempts = [
    { method: 'sessions.messages.subscribe', params: { key: sessionKey } },
    { method: 'sessions.subscribe',          params: { sessionKey } },
  ];
  for (const a of attempts) {
    try {
      const r = await openclaw.rpc(a.method, a.params, RPC_TIMEOUT_MS);
      console.log(`[openclaw-panels] ✓ [${tag}] ${a.method} ${JSON.stringify(a.params)} → ${JSON.stringify(r)?.slice(0,200)}`);
    } catch (e) {
      console.log(`[openclaw-panels] ✕ [${tag}] ${a.method}: ${e.code || ''} ${e.message}`);
    }
  }
}

// hello-ok 后调用 —— 订阅 main session，并对 hello 里带出的任何活跃 session 也订阅
async function onConnected(helloPayload) {
  subscribedKeys.clear();    // 重连时重新订阅

  const defaults = helloPayload?.snapshot?.sessionDefaults || helloPayload?.sessionDefaults || {};
  const mainKey  = defaults.mainSessionKey || 'agent:main:main';
  if (!loggedOk.has('sessionDefaults')) {
    loggedOk.add('sessionDefaults');
    console.log(`[openclaw-panels] sessionDefaults → ${JSON.stringify(defaults)}`);
  }

  await subscribeSession(mainKey, { tag: 'main' });

  // hello-ok snapshot 里可能带有当前活跃 sessions（cron 进行中的等），一并订阅
  const existing = helloPayload?.snapshot?.sessions || helloPayload?.sessions || [];
  if (Array.isArray(existing)) {
    for (const s of existing) {
      const k = typeof s === 'string' ? s : (s?.key || s?.sessionKey);
      if (k && k !== mainKey) await subscribeSession(k, { tag: 'snapshot' });
    }
  }
}

// sessions.changed phase=start：新 session 创建出来 → 动态订阅。
// 这样 cron / voice 等临时 session 一冒头就纳入订阅，不漏事件。
function onSessionsChanged(payload) {
  const key = payload?.sessionKey || payload?.session?.key;
  if (!key) return;
  if (!subscribedKeys.has(key)) {
    subscribeSession(key, { tag: `dyn:${payload?.phase || '?'}` }).catch(() => {});
  }
}

// ── public lifecycle ──────────────────────────────────────

export function start() {
  if (state.started) return;
  state.started = true;
  state.toolSub    = openclaw.on('session.tool',    onSessionTool);
  state.agentSub   = openclaw.on('agent',           onAgentEvent);
  state.msgSub     = openclaw.on('session.message', onSessionMessage);
  state.changedSub = openclaw.on('sessions.changed',onSessionsChanged);
  state.anySub     = openclaw.onAny(onAnyEvent);
  state.connSub    = openclaw.onConnected(onConnected);

  const tick = () => { pollOnce().catch(() => {}); };
  state.pollTimer = setInterval(tick, POLL_MS);
  if (state.pollTimer.unref) state.pollTimer.unref();
  // 开头立刻跑一次（连接没上也无妨，pollOnce 内部会跳过）
  setTimeout(tick, 500);
  console.log('[openclaw-panels] started');
}

export function stop() {
  state.started = false;
  clearInterval(state.pollTimer);
  if (state.toolSub)  { state.toolSub();  state.toolSub  = null; }
  if (state.agentSub) { state.agentSub(); state.agentSub = null; }
  if (state.msgSub)   { state.msgSub();   state.msgSub   = null; }
  if (state.anySub)   { state.anySub();   state.anySub   = null; }
  if (state.connSub)  { state.connSub();  state.connSub  = null; }
}

// ── snapshots ─────────────────────────────────────────────

function modelsArray() {
  const m = state.models;
  return asArr(m?.models || m?.items || m?.data || m);
}

// usage.status shape: { updatedAt, providers: [{provider, displayName, windows: [{calls, avgLatencyMs?, ...}]}] }
// 先按 provider 聚合：累计各 window 的 calls 和加权平均延迟。目前 windows 常为空。
function usageByProvider() {
  const map = {};
  const providers = asArr(state.usage?.providers);
  for (const p of providers) {
    const windows = asArr(p.windows);
    let calls = 0;
    let latSum = 0, latWt = 0;
    for (const w of windows) {
      const c = Number(w.calls ?? w.requests ?? w.count ?? 0) || 0;
      calls += c;
      const lat = Number(w.avgLatencyMs ?? w.avgMs ?? 0);
      if (lat > 0) { latSum += lat * (c || 1); latWt += (c || 1); }
    }
    map[p.provider] = {
      displayName: p.displayName || p.provider,
      calls,
      avgLatencyMs: latWt ? latSum / latWt : null,
    };
  }
  return map;
}

export function llmStatusSnapshot() {
  const models = modelsArray();
  const byProv = usageByProvider();

  if (!models.length) {
    // 还没拿到 models.list 时给个占位，别让卡片闪空白
    return [{
      name: openclaw.isConnected() ? 'Loading…' : 'OpenClaw offline',
      status: openclaw.isConnected() ? 'standby' : 'offline',
      stats: [
        { label: 'Gateway',     value: openclaw.isConnected() ? 'connected' : 'offline' },
        { label: 'models.list', value: 'pending' },
        { label: '—',           value: '—' },
      ],
    }];
  }

  // 有 alias 的 model 就是"默认正在用的" —— active；其它为 standby
  const defaultModel = models.find(m => m.alias) || models[0];

  return models.slice(0, 3).map((m) => {
    const name = m.alias ? `${m.name} · ${m.alias}` : (m.name || m.id);
    const u    = byProv[m.provider] || {};
    const isDefault = (m === defaultModel);

    // 有真实 call 数据就显示 latency / calls；否则退回静态元信息
    const hasCallData = u.calls > 0;
    const stats = hasCallData
      ? [
          { label: 'Avg latency', value: u.avgLatencyMs ? `${Math.round(u.avgLatencyMs)}ms` : '—' },
          { label: 'Today calls', value: String(u.calls) },
          { label: 'Provider',    value: u.displayName || m.provider || '—' },
        ]
      : [
          { label: 'Provider',  value: u.displayName || m.provider || '—' },
          { label: 'Context',   value: m.contextWindow ? `${Math.round(m.contextWindow/1024)}K` : '—' },
          { label: 'Reasoning', value: m.reasoning ? 'yes' : 'no' },
        ];

    return {
      name,
      status: m.status || (isDefault ? 'active' : 'standby'),
      stats,
    };
  });
}

export function toolLogSnapshot() {
  return [...state.toolLog];
}

export function voiceStateSnapshot() {
  const w = state.voicewake || {};
  // 真实 shape: { triggers: ['蜡笔小新', 'computer'] }
  const triggers = asArr(w.triggers || w.wakeWords || w.words || w.phrases);
  const zh = triggers.find(x => /[\u4e00-\u9fa5]/.test(String(x))) || triggers[0] || '小管家';
  const en = triggers.find(x => !/[\u4e00-\u9fa5]/.test(String(x))) || triggers[1] || 'Hey Home';

  const models = modelsArray();
  const primary = models.find(m => m.alias) || models[0] || {};
  // voice-bar 是单行窄标签，优先 alias（"GLM"）再退到全名
  const model = primary.alias || primary.name || primary.id || 'OpenClaw';

  // talk.config 真实 shape:
  //   { config: { talk: { provider, providers: {...},
  //       resolved: { provider, config: { voiceId, modelId, baseUrl, ... } } } } }
  const tc = state.talkConfig?.config?.talk || state.talkConfig?.talk || state.talkConfig || {};
  const resolved = tc.resolved?.config || tc.providers?.[tc.provider] || {};
  const tts_provider = tc.resolved?.provider || tc.provider || null;
  const tts_voice    = resolved.voiceId || resolved.voice || null;
  const tts_model    = resolved.modelId || resolved.model || null;

  return {
    wake_word_zh: String(zh),
    wake_word_en: String(en),
    model,
    tts_provider,
    tts_voice,
    tts_model,
    today_energy_kwh: null,     // energy 来自其它 topic
    gateway_ok: openclaw.isConnected(),
  };
}

export function nodesSnapshot() {
  const snap = openclaw._state?.().snapshot || {};
  const presence = asArr(snap.presence);
  return presence.map((p) => {
    const ts = p.ts || p.lastSeenAt || 0;
    const online = ts > 0 && (Date.now() - ts) < NODE_ONLINE_WINDOW_MS;
    const meta = [p.platform, p.deviceFamily, p.mode ? `mode ${p.mode}` : null]
      .filter(Boolean).join(' · ');
    let ping_label = 'offline', ping_class = '';
    if (online) {
      if (p.mode === 'gateway') { ping_label = 'local'; ping_class = 'good'; }
      else                      { ping_label = 'online'; ping_class = 'good'; }
    }
    return {
      name: p.host || p.ip || '(node)',
      meta,
      online,
      ping_label,
      ping_class,
    };
  });
}

export function sysSummarySnapshot() {
  const nodes = nodesSnapshot();
  const modelsOk = modelsArray().length > 0 || openclaw.isConnected();
  return {
    gateway_ok: openclaw.isConnected(),
    model_ok:   modelsOk,
    nodes_on:   nodes.filter(n => n.online).length,
    nodes_off:  nodes.filter(n => !n.online).length,
  };
}

export function onToolLogAppend(handler) {
  state.toolLogListeners.add(handler);
  return () => state.toolLogListeners.delete(handler);
}

// ── 测试入口 ──────────────────────────────────────────────
// 仅用于 unit test；允许在没有真实 WS 连接的情况下把事件 fixture
// 喂进 handler 以验证 state.toolLog / snapshot 的变化。
export const _test = {
  reset() {
    state.toolLog.length = 0;
    state.toolLogListeners.clear();
  },
  feedSessionTool:    (p) => onSessionTool(p),
  feedAgentEvent:     (p) => onAgentEvent(p),
  feedSessionMessage: (p) => onSessionMessage(p),
  getToolLog: () => [...state.toolLog],
};
