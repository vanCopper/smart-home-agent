// server/server.js
// ────────────────────────────────────────────────────────────────
// Smart Home Hub — 本地 Web 服务
//
//   • HTTP (Express) 提供 /public 下的静态资源
//   • WebSocket (ws) 跑在同一端口，路径 /ws
//   • Topic 订阅模式：
//       client → { type:'subscribe',   topics:['env/indoor', ...] }
//       client → { type:'unsubscribe', topics:[...] }
//       client → { type:'rpc', id, method:'devices.toggle', params:{ id:'ac_living' } }
//       server → { type:'event', topic:'env/indoor', data:{...}, ts: 172... }
//       server → { type:'rpc_result', id, ok:true, data:{...} }
//
//   当前挂的是 ./mock/*，后续替换为真实数据源（OpenClaw Gateway、
//   智能家居 API 等）时：只需在 publish() 和 rpc handlers 里改实现，
//   前端 topic 定义不变。
// ────────────────────────────────────────────────────────────────

import express       from 'express';
import { WebSocketServer } from 'ws';
import http          from 'node:http';
import path          from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOPICS, TOPIC_TICK } from './topics.js';
import * as hub    from './mock/hub.js';
import * as sys    from './mock/system.js';
import * as openclaw from './openclaw.js';
import * as claw   from './openclaw-panels.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const PORT = Number(process.env.PORT) || 3300;
const HOST = process.env.HOST || '0.0.0.0';

// ── HTTP 层 ─────────────────────────────────────────────────────
const app = express();
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.use(express.json());
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/api/topics', (_req, res) => res.json({ topics: Object.values(TOPICS) }));

const server = http.createServer(app);

// ── WebSocket 层 ────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

/** @type {Map<import('ws').WebSocket, Set<string>>} */
const subscriptions = new Map();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function publish(topic, data) {
  const payload = { type: 'event', topic, data, ts: Date.now() };
  const frame = JSON.stringify(payload);
  for (const [ws, subs] of subscriptions) {
    if (subs.has(topic) && ws.readyState === ws.OPEN) ws.send(frame);
  }
}

// 某个客户端 subscribe 时，立刻把各 topic 当前快照推一遍
const SNAPSHOTS = {
  [TOPICS.CLOCK]:          hub.clockSnapshot,
  [TOPICS.WEATHER]:        hub.weatherSnapshot,
  [TOPICS.ENV_INDOOR]:     hub.envIndoorSnapshot,
  [TOPICS.ENV_OUTDOOR]:    hub.envOutdoorSnapshot,
  [TOPICS.DEVICES_LIST]:   hub.devicesSnapshot,
  [TOPICS.SCHEDULE_TODAY]: hub.scheduleTodaySnapshot,
  [TOPICS.SCHEDULE_INFO]:  hub.scheduleTomorrowSnapshot,
  [TOPICS.CAMERA_LIST]:    hub.camerasSnapshot,
  [TOPICS.SCENES_LIST]:    hub.scenesSnapshot,
  [TOPICS.VOICE_STATE]:    claw.voiceStateSnapshot,
  [TOPICS.GW_STATUS]:      openclaw.gatewaySnapshot,
  [TOPICS.LLM_STATUS]:     claw.llmStatusSnapshot,
  [TOPICS.NODES_LIST]:     claw.nodesSnapshot,
  [TOPICS.TOOL_LOG]:       claw.toolLogSnapshot,
  [TOPICS.ENERGY]:         sys.energySnapshot,
  [TOPICS.SYS_SUMMARY]:    claw.sysSummarySnapshot,
};

function pushSnapshot(ws, topic) {
  const fn = SNAPSHOTS[topic];
  if (!fn) return;
  try {
    send(ws, { type: 'event', topic, data: fn(), ts: Date.now() });
  } catch (e) {
    console.error('snapshot error', topic, e);
  }
}

// ── Internal voice API (127.0.0.1 only, used by voice-agent) ────
function rejectNonLocal(req, res) {
  const ip = req.socket.remoteAddress;
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    res.status(403).json({ error: 'forbidden' });
    return true;
  }
  return false;
}

app.post('/internal/voice/event', (req, res) => {
  if (rejectNonLocal(req, res)) return;
  const { type, text = '' } = req.body || {};
  if (!type) return res.status(400).json({ error: 'type required' });
  publish(TOPICS.VOICE_EVENT, { type, text });
  res.json({ ok: true });
});

app.post('/internal/voice/send', async (req, res) => {
  if (rejectNonLocal(req, res)) return;
  const { text, sessionKey = 'agent:main:main' } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();   // send headers immediately, enable chunked streaming

  const sse = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

  // Debug: dump all events during this SSE request (first 40) to find real event shape
  let _dbgCount = 0;
  const unsubDbg = openclaw.onAny((event, payload) => {
    if (event === 'connect.challenge') return;
    if (_dbgCount++ < 40) {
      const d = JSON.stringify(payload);
      console.log(`[voice/send dbg] event=${event} ${d?.length > 300 ? d.slice(0,300)+'…' : d}`);
    }
  });

  const unsubAgent = openclaw.on('agent', (payload) => {
    if (payload?.sessionKey && payload.sessionKey !== sessionKey) return;
    const stream = payload?.stream;
    const data   = payload?.data || {};

    if (stream === 'assistant') {
      // delta: data.delta is the incremental chunk; data.text is the cumulative text
      const chunk = data.delta ?? '';
      if (chunk) sse({ type: 'delta', text: chunk });
    } else if (stream === 'lifecycle' && data.phase === 'end') {
      sse({ type: 'done' });
      cleanup();
    }
  });

  const unsubMsg = openclaw.on('session.message', (payload) => {
    // sessionKey may be at top level or in payload.session
    const key = payload?.sessionKey || payload?.session?.key;
    if (key && key !== sessionKey) return;
    const msg = payload?.message || payload;
    if (msg?.role !== 'assistant') return;
    // Only use as fallback if agent stream didn't already finish
    const full = (msg.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');
    if (full) sse({ type: 'complete', text: full });
    // Don't call cleanup here — agent lifecycle:end will do it
  });

  let done = false;
  const timeout = setTimeout(() => { sse({ type: 'done' }); cleanup(); }, 30_000);

  function cleanup() {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    unsubDbg();
    unsubAgent();
    unsubMsg();
    if (!res.writableEnded) res.end();
  }

  res.on('close', cleanup);

  // Ensure we're subscribed to this session's streaming events before sending.
  // subscribeSession is idempotent (tracks a Set internally).
  await claw.subscribeSession(sessionKey, { tag: 'voice' });

  // Try to ensure the session exists (no-op if already exists).
  try {
    const cr = await openclaw.rpc('sessions.create', { key: sessionKey }, 5000);
    console.log(`[voice/send] sessions.create → ${JSON.stringify(cr)?.slice(0, 200)}`);
  } catch (e) {
    // "already exists" or unsupported — both fine, proceed
    console.log(`[voice/send] sessions.create skip: ${e.message}`);
  }

  try {
    const sendResult = await openclaw.rpc('sessions.send', { key: sessionKey, message: text });
    console.log(`[voice/send] sessions.send → ${JSON.stringify(sendResult)?.slice(0, 200)}`);
  } catch (e) {
    console.error(`[voice/send] sessions.send error: ${e.message}`);
    sse({ type: 'error', message: e.message });
    cleanup();
  }
});

// ── RPC handlers (client-driven actions) ────────────────────────
const RPC = {
  'devices.toggle': ({ id }) => {
    const res = hub.toggleDevice(id);
    if (!res) return { ok: false, error: 'device not found or locked' };
    publish(TOPICS.DEVICE_STATE, res);
    publish(TOPICS.DEVICES_LIST, hub.devicesSnapshot());
    return { ok: true, data: res };
  },
  'scene.run': ({ id, name_zh }) => {
    const label = name_zh || id;
    publish(TOPICS.VOICE_EVENT, { type:'said',  text: `"启动${label}模式"` });
    publish(TOPICS.VOICE_EVENT, { type:'reply', text: `好的，${label}模式已启动` });
    return { ok: true, data: { id } };
  },
  'voice.greet': () => {
    publish(TOPICS.VOICE_EVENT, { type:'said',  text:'"小管家，你好"' });
    publish(TOPICS.VOICE_EVENT, { type:'reply', text:'你好！有什么可以帮你的？' });
    return { ok: true };
  },
};

wss.on('connection', (ws, req) => {
  subscriptions.set(ws, new Set());
  console.log(`[ws] + client (${req.socket.remoteAddress}) — ${subscriptions.size} total`);

  send(ws, { type: 'hello', ts: Date.now(), server: 'smart-home-hub/0.1.0' });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'subscribe' && Array.isArray(msg.topics)) {
      const subs = subscriptions.get(ws);
      for (const t of msg.topics) {
        subs.add(t);
        pushSnapshot(ws, t);
      }
    } else if (msg.type === 'unsubscribe' && Array.isArray(msg.topics)) {
      const subs = subscriptions.get(ws);
      for (const t of msg.topics) subs.delete(t);
    } else if (msg.type === 'rpc') {
      const fn = RPC[msg.method];
      const result = fn
        ? (() => { try { return fn(msg.params || {}); } catch (e) { return { ok:false, error:String(e) }; } })()
        : { ok: false, error: `unknown method: ${msg.method}` };
      send(ws, { type: 'rpc_result', id: msg.id, ...result });
    } else if (msg.type === 'ping') {
      send(ws, { type: 'pong', ts: Date.now() });
    }
  });

  ws.on('close', () => {
    subscriptions.delete(ws);
    console.log(`[ws] - client — ${subscriptions.size} remaining`);
  });

  ws.on('error', (e) => console.warn('[ws] error', e.message));
});

// ── Periodic publishers (mock → 换成真实数据源时替换这里) ─────────
function startTicker(topic, fn, interval) {
  setInterval(() => {
    try { publish(topic, fn()); }
    catch (e) { console.error('publish error', topic, e); }
  }, interval);
}

startTicker(TOPICS.CLOCK,       hub.clockSnapshot,        TOPIC_TICK[TOPICS.CLOCK]);
startTicker(TOPICS.ENV_INDOOR,  hub.envIndoorSnapshot,    TOPIC_TICK[TOPICS.ENV_INDOOR]);
startTicker(TOPICS.ENV_OUTDOOR, hub.envOutdoorSnapshot,   TOPIC_TICK[TOPICS.ENV_OUTDOOR]);
startTicker(TOPICS.GW_STATUS,   openclaw.gatewaySnapshot,   TOPIC_TICK[TOPICS.GW_STATUS]);
startTicker(TOPICS.LLM_STATUS,  claw.llmStatusSnapshot,     TOPIC_TICK[TOPICS.LLM_STATUS]);
startTicker(TOPICS.NODES_LIST,  claw.nodesSnapshot,         TOPIC_TICK[TOPICS.NODES_LIST]);
startTicker(TOPICS.VOICE_STATE, claw.voiceStateSnapshot,    TOPIC_TICK[TOPICS.VOICE_STATE] || 5_000);
startTicker(TOPICS.ENERGY,      sys.energySnapshot,         TOPIC_TICK[TOPICS.ENERGY]);
startTicker(TOPICS.SYS_SUMMARY, claw.sysSummarySnapshot,    TOPIC_TICK[TOPICS.SYS_SUMMARY]);

// 真实工具调用追加：session.tool 事件 → TOOL_LOG_APPEND
claw.onToolLogAppend((entry) => publish(TOPICS.TOOL_LOG_APPEND, entry));

// 每分钟刷一次天气 (mock 随机波动)
setInterval(() => publish(TOPICS.WEATHER, hub.weatherSnapshot()), 60_000);

// ── 启动 ─────────────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
  console.log(`\nSmart Home Hub`);
  console.log(`  HTTP  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  WS    ws://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/ws`);
  console.log(`  iPad  http://mac-mini.local:${PORT}\n`);

  // 拉起 OpenClaw adapter（连不上也不阻塞）
  openclaw.start();
  claw.start();
});

// 进程退出时关掉 OpenClaw 连接，避免僵尸重连定时器
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { claw.stop(); openclaw.stop(); process.exit(0); });
}
