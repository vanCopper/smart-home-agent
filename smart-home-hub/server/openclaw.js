// server/openclaw.js
// ────────────────────────────────────────────────────────────────
// OpenClaw Gateway adapter — WebSocket v3 长连版
//
//   从 HTTP /health 轮询升级成 WS v3 签名握手 + 长连接：
//     · 首次启动生成 Ed25519 keypair，落盘在
//       ~/.openclaw/smart-home-hub/identity.json
//     · 按源码里的 v3 公式签名通过 connect (loopback +
//       controlUi.dangerouslyDisableDeviceAuth=true 下直接放行)
//     · 连接成功后每 5s 调用 status RPC 刷新 snapshot
//     · 断线指数退避重连 (1s → 10s)
//
//   公开 API（沿用原来那四个，前端侧 / server.js 不需要改动）：
//     start(), stop(), isConnected(), gatewaySnapshot()
//
//   新增（给后续 LLM_STATUS / TOOL_LOG / VOICE 面板用）：
//     rpc(method, params, timeoutMs)     → Promise<payload>
//     on(event, handler)                 → unsubscribe 函数
//
//   环境变量：
//     OPENCLAW_WS     默认 ws://127.0.0.1:18789
//     OPENCLAW_TOKEN  默认空；v3 签名 payload 里 token 段
// ────────────────────────────────────────────────────────────────

import { WebSocket } from 'ws';
import {
  createHash, generateKeyPairSync, sign as edSign,
  createPrivateKey,
} from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const WS_URL = process.env.OPENCLAW_WS || 'ws://127.0.0.1:18789';
const TOKEN  = process.env.OPENCLAW_TOKEN ?? '';
const IDENTITY_PATH = join(homedir(), '.openclaw', 'smart-home-hub', 'identity.json');
const STATUS_POLL_MS = 5_000;
const RPC_TIMEOUT_MS = 5_000;

const PLATFORM = process.platform === 'darwin' ? 'macos'
                : process.platform === 'linux'  ? 'linux'
                : process.platform === 'win32'  ? 'windows'
                : process.platform;
const DEVICE_FAMILY = 'desktop';
const CLIENT_ID = 'cli';
const CLIENT_MODE = 'cli';
const CLIENT_VERSION = '0.0.1';
const ROLE = 'operator';
const SCOPES = ['operator.read'];

const PORT = (() => {
  try { return Number(new URL(WS_URL).port) || 18789; } catch { return 18789; }
})();

const state = {
  ws: null,
  connected: false,
  started: false,
  reconnectDelay: 1000,
  reconnectTimer: null,
  statusTimer: null,
  identity: null,
  snapshot: null,                 // 最近一次 hello-ok.snapshot 或 status RPC 返回
  snapshotAt: 0,
  latencyMs: null,
  firstOkAt: null,
  bootReqId: null,
  connOpenedAt: 0,
  rpcSeq: 0,
  rpcPending: new Map(),          // id -> { resolve, reject, timer }
  eventHandlers: new Map(),       // event -> Set<handler>
  anyEventHandlers: new Set(),    // 每个收到的事件都会回调（除 connect.challenge）
  connectHandlers: new Set(),     // 每次 hello-ok 后调一次（含首连 + 重连）
  deviceToken: null,
  connId: null,
};

// ── identity ───────────────────────────────────────────────

function loadOrCreateIdentity() {
  if (existsSync(IDENTITY_PATH)) {
    try {
      const j = JSON.parse(readFileSync(IDENTITY_PATH, 'utf8'));
      if (j.privateKeyPem && j.publicKeyB64 && j.deviceId) {
        const privateKey = createPrivateKey(j.privateKeyPem);
        return { privateKey, deviceId: j.deviceId, publicKeyB64: j.publicKeyB64 };
      }
    } catch (e) {
      console.warn(`[openclaw] identity file corrupt (${e.message}), regenerating`);
    }
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const rawPub = Buffer.from(jwk.x, 'base64url');
  const publicKeyB64 = rawPub.toString('base64');
  const deviceId = createHash('sha256').update(rawPub).digest('hex');
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  mkdirSync(dirname(IDENTITY_PATH), { recursive: true });
  writeFileSync(IDENTITY_PATH, JSON.stringify({
    deviceId, publicKeyB64, privateKeyPem,
    createdAt: new Date().toISOString(),
  }, null, 2), 'utf8');
  console.log(`[openclaw] identity created: ${deviceId}`);
  return { privateKey, deviceId, publicKeyB64 };
}

function signV3({ deviceId, signedAtMs, nonce }) {
  const payload = [
    'v3', deviceId, CLIENT_ID, CLIENT_MODE, ROLE,
    SCOPES.join(','), String(signedAtMs), TOKEN, nonce,
    PLATFORM, DEVICE_FAMILY,
  ].join('|');
  return edSign(null, Buffer.from(payload, 'utf8'), state.identity.privateKey).toString('base64');
}

// ── WS lifecycle ───────────────────────────────────────────

function connect() {
  if (state.ws && (state.ws.readyState === WebSocket.CONNECTING || state.ws.readyState === WebSocket.OPEN)) return;
  let ws;
  try { ws = new WebSocket(WS_URL); }
  catch (e) {
    console.warn(`[openclaw] open threw: ${e.message}`);
    return scheduleReconnect();
  }
  state.ws = ws;
  state.connOpenedAt = Date.now();

  ws.on('open', () => { /* 等 connect.challenge 事件 */ });
  ws.on('error', (e) => {
    console.warn(`[openclaw] ws error: ${e.code || e.message}`);
  });
  ws.on('close', () => {
    if (state.connected) console.warn('[openclaw] ws closed, reconnecting…');
    markDown();
    scheduleReconnect();
  });
  ws.on('message', (buf) => onMessage(buf));
}

function onMessage(buf) {
  let msg;
  try { msg = JSON.parse(buf.toString('utf8')); } catch { return; }

  // 1) 握手挑战 → 回签名
  if (msg.type === 'event' && msg.event === 'connect.challenge') {
    const nonce = msg.payload?.nonce;
    if (!nonce) { console.warn('[openclaw] challenge missing nonce'); return; }
    const signedAt = Date.now();
    const signature = signV3({ deviceId: state.identity.deviceId, signedAtMs: signedAt, nonce });
    const id = `boot-${signedAt}`;
    state.bootReqId = id;
    state.ws.send(JSON.stringify({
      type: 'req', id, method: 'connect',
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: CLIENT_ID, version: CLIENT_VERSION,
          platform: PLATFORM, mode: CLIENT_MODE,
          deviceFamily: DEVICE_FAMILY,
        },
        role: ROLE,
        scopes: SCOPES,
        device: {
          id: state.identity.deviceId,
          publicKey: state.identity.publicKeyB64,
          signature,
          signedAt,
          nonce,
        },
      },
    }));
    return;
  }

  // 2) boot 的 hello-ok
  if (msg.type === 'res' && msg.id === state.bootReqId) {
    if (msg.ok && msg.payload?.type === 'hello-ok') {
      state.connected   = true;
      state.snapshot    = msg.payload.snapshot || null;
      state.snapshotAt  = Date.now();
      state.latencyMs   = Date.now() - state.connOpenedAt;
      if (!state.firstOkAt) state.firstOkAt = Date.now();
      state.deviceToken = msg.payload.auth?.deviceToken || null;
      state.connId      = msg.payload.server?.connId || null;
      state.reconnectDelay = 1000;
      console.log(`[openclaw] ✓ connected  v${msg.payload.protocol}  connId=${state.connId}  (${state.latencyMs}ms)`);
      for (const h of state.connectHandlers) {
        try { h(msg.payload); }
        catch (e) { console.error('[openclaw] connectHandler error:', e); }
      }
    } else {
      console.warn(`[openclaw] connect failed: ${JSON.stringify(msg.error)}`);
      try { state.ws.close(); } catch {}
    }
    return;
  }

  // 3) 常规 RPC 结果
  if (msg.type === 'res' && msg.id) {
    const p = state.rpcPending.get(msg.id);
    if (p) {
      clearTimeout(p.timer);
      state.rpcPending.delete(msg.id);
      if (msg.ok) p.resolve(msg.payload ?? null);
      else p.reject(Object.assign(
        new Error(msg.error?.message || 'rpc failed'),
        { code: msg.error?.code }
      ));
    }
    return;
  }

  // 4) 事件分发
  if (msg.type === 'event') {
    for (const h of state.anyEventHandlers) {
      try { h(msg.event, msg.payload, msg); }
      catch (e) { console.error('[openclaw] anyEventHandler error:', e); }
    }
    const handlers = state.eventHandlers.get(msg.event);
    if (handlers) {
      for (const h of handlers) {
        try { h(msg.payload, msg); }
        catch (e) { console.error(`[openclaw] event handler ${msg.event} error:`, e); }
      }
    }
  }
}

function markDown() {
  state.connected  = false;
  state.latencyMs  = null;
  state.firstOkAt  = null;
  state.bootReqId  = null;
  state.deviceToken = null;
  state.connId     = null;
  for (const [, p] of state.rpcPending) {
    clearTimeout(p.timer);
    p.reject(new Error('ws closed'));
  }
  state.rpcPending.clear();
}

function scheduleReconnect() {
  if (!state.started) return;
  clearTimeout(state.reconnectTimer);
  const delay = state.reconnectDelay;
  state.reconnectTimer = setTimeout(() => connect(), delay);
  if (state.reconnectTimer.unref) state.reconnectTimer.unref();
  state.reconnectDelay = Math.min(Math.floor(delay * 1.6), 10_000);
}

// ── public API ─────────────────────────────────────────────

export function start() {
  if (state.started) return;
  state.started = true;
  state.identity = loadOrCreateIdentity();
  console.log(`[openclaw] identity: ${state.identity.deviceId}`);
  console.log(`[openclaw] connecting ${WS_URL}`);
  connect();

  // 定期 status RPC 刷新 snapshot（拿到最新 sessions / uptime）
  state.statusTimer = setInterval(() => {
    if (!state.connected) return;
    rpc('status', {}, 3_000)
      .then((p) => { if (p) { state.snapshot = p; state.snapshotAt = Date.now(); } })
      .catch((e) => { if (e.code !== 'NOT_CONNECTED') console.warn(`[openclaw] status rpc failed: ${e.message}`); });
  }, STATUS_POLL_MS);
  if (state.statusTimer.unref) state.statusTimer.unref();
}

export function stop() {
  state.started = false;
  clearTimeout(state.reconnectTimer);
  clearInterval(state.statusTimer);
  try { state.ws?.close(); } catch {}
  markDown();
}

export function isConnected() { return state.connected; }

export function gatewaySnapshot() {
  const s = state.snapshot || {};
  const h = s.health || {};
  const sessionsCount = h.sessions?.count ?? 0;

  // uptime: snapshot 里 uptimeMs 是采样时刻的值，外推到现在
  let uptimeMs = 0;
  if (state.connected && typeof s.uptimeMs === 'number') {
    uptimeMs = s.uptimeMs + Math.max(0, Date.now() - state.snapshotAt);
  }

  return {
    running:       state.connected,
    ws:            state.connected ? 'connected' : 'offline',
    latency_ms:    state.connected ? state.latencyMs : null,
    port:          PORT,
    sessions:      sessionsCount,
    today_calls:   0,      // TODO: usage.cost RPC
    mem_used_gb:   null,   // TODO: 来自 presence.system 或专门的 RPC
    mem_total_gb:  null,
    cpu_pct:       null,
    uptime_ms:     uptimeMs,
  };
}

// ── 给下游面板用的 RPC / 事件订阅 ───────────────────────────

export function rpc(method, params = {}, timeoutMs = RPC_TIMEOUT_MS) {
  if (!state.connected) {
    return Promise.reject(Object.assign(new Error('not connected'), { code: 'NOT_CONNECTED' }));
  }
  const id = `r${++state.rpcSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.rpcPending.delete(id);
      reject(Object.assign(new Error(`rpc timeout: ${method}`), { code: 'RPC_TIMEOUT' }));
    }, timeoutMs);
    state.rpcPending.set(id, { resolve, reject, timer });
    try {
      state.ws.send(JSON.stringify({ type: 'req', id, method, params }));
    } catch (e) {
      clearTimeout(timer);
      state.rpcPending.delete(id);
      reject(e);
    }
  });
}

export function on(event, handler) {
  let set = state.eventHandlers.get(event);
  if (!set) { set = new Set(); state.eventHandlers.set(event, set); }
  set.add(handler);
  return () => {
    set.delete(handler);
    if (set.size === 0) state.eventHandlers.delete(event);
  };
}

// 捕获所有事件 —— 用于 debug / 事件发现
export function onAny(handler) {
  state.anyEventHandlers.add(handler);
  return () => state.anyEventHandlers.delete(handler);
}

// hello-ok 之后立即触发（含首连 + 每次重连）—— 用于连上就订阅
export function onConnected(handler) {
  state.connectHandlers.add(handler);
  // 如果已经连着，立刻补调一次，让调用方不用关心自己是早到还是晚到
  if (state.connected) {
    try { handler(state.snapshot); }
    catch (e) { console.error('[openclaw] onConnected immediate error:', e); }
  }
  return () => state.connectHandlers.delete(handler);
}

// 给外部 debug 用
export function _state() { return state; }
