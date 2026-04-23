// server/standalone.js
// ────────────────────────────────────────────────────────────────
// 零依赖入口：不需要 `npm install`，直接 `node server/standalone.js`。
// 只用 Node 内置模块手搓 HTTP + WebSocket (RFC 6455)。
// 功能和 server.js 完全一致——共享同一套 mock 数据和 topic 定义。
//
// 不足：
//   - 手搓 WebSocket 只实现了文本帧 / ping / pong / close；
//     payload > 64KB 的帧未处理分片（mock 用不到）
//   - 不支持 TLS / 压缩 / per-message-deflate
// 生产推荐用 server.js (Express + ws)。
// ────────────────────────────────────────────────────────────────

import http  from 'node:http';
import fs    from 'node:fs';
import path  from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { TOPICS, TOPIC_TICK } from './topics.js';
import * as hub from './mock/hub.js';
import * as sys from './mock/system.js';
import * as openclaw from './openclaw.js';
import * as claw from './openclaw-panels.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const PORT = Number(process.env.PORT) || 3300;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html':'text/html; charset=utf-8',
  '.js':  'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2':'font/woff2',
  '.map': 'application/json',
};

// ── 1. 静态文件 + 健康检查 HTTP server ───────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type':'application/json' });
    return res.end(JSON.stringify({ ok:true, ts: Date.now() }));
  }
  if (req.url === '/api/topics') {
    res.writeHead(200, { 'content-type':'application/json' });
    return res.end(JSON.stringify({ topics: Object.values(TOPICS) }));
  }

  // static
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  // strip any `..` attempts
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA fallback: unknown route → index.html
      if (!/\.[a-zA-Z0-9]+$/.test(urlPath)) {
        return serveFile(path.join(PUBLIC_DIR, 'index.html'), res);
      }
      res.writeHead(404); return res.end('Not found');
    }
    serveFile(file, res, stat);
  });
});

function serveFile(file, res, stat) {
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control':'no-cache' });
  fs.createReadStream(file).pipe(res);
}

// ── 2. WebSocket (RFC 6455, 手写) ───────────────────────────────
const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** @type {Set<{sock:import('net').Socket, subs:Set<string>}>} */
const clients = new Set();

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') { socket.destroy(); return; }
  if ((req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  const accept = crypto.createHash('sha1').update(key + MAGIC).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);

  const client = { sock: socket, subs: new Set(), buf: Buffer.alloc(0) };
  clients.add(client);
  console.log(`[ws] + client (${socket.remoteAddress}) — ${clients.size} total`);

  // welcome
  wsSend(client, { type:'hello', ts: Date.now(), server:'smart-home-hub/0.1.0 (standalone)' });

  socket.on('data', (chunk) => {
    client.buf = Buffer.concat([client.buf, chunk]);
    while (true) {
      const frame = wsReadFrame(client.buf);
      if (!frame) break;
      client.buf = client.buf.slice(frame.consumed);

      if (frame.opcode === 0x8) {          // close
        wsClose(client);
        return;
      } else if (frame.opcode === 0x9) {   // ping
        wsSendRaw(client, 0xA, frame.payload);
      } else if (frame.opcode === 0x1) {   // text
        handleMessage(client, frame.payload.toString('utf8'));
      }
      // ignore binary/continuation
    }
  });

  socket.on('close', () => {
    clients.delete(client);
    console.log(`[ws] - client — ${clients.size} remaining`);
  });
  socket.on('error', () => { clients.delete(client); });
});

function wsReadFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) === 0x80;
  let len = b1 & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    // only support <4GB payloads
    const hi = buf.readUInt32BE(2), lo = buf.readUInt32BE(6);
    if (hi !== 0) return null;
    len = lo; offset = 10;
  }
  let mask;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.slice(offset, offset + 4); offset += 4;
  }
  if (buf.length < offset + len) return null;
  let payload = buf.slice(offset, offset + len);
  if (masked) {
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
    payload = out;
  }
  return { opcode, payload, consumed: offset + len };
}

function wsSendRaw(client, opcode, payload) {
  if (!client.sock.writable) return;
  const len = payload.length;
  let header;
  if (len < 126)       { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536){ header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else                  { header = Buffer.alloc(10); header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
  header[0] = 0x80 | (opcode & 0x0f);  // FIN=1
  try { client.sock.write(Buffer.concat([header, payload])); }
  catch (e) { /* socket gone */ }
}

function wsSend(client, obj) {
  wsSendRaw(client, 0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
}

function wsClose(client) {
  try { client.sock.end(); } catch {}
  clients.delete(client);
}

function handleMessage(client, text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }

  if (msg.type === 'subscribe' && Array.isArray(msg.topics)) {
    for (const t of msg.topics) {
      client.subs.add(t);
      pushSnapshot(client, t);
    }
  } else if (msg.type === 'unsubscribe' && Array.isArray(msg.topics)) {
    for (const t of msg.topics) client.subs.delete(t);
  } else if (msg.type === 'rpc') {
    const fn = RPC[msg.method];
    let result;
    if (fn) {
      try { result = fn(msg.params || {}); }
      catch (e) { result = { ok:false, error:String(e) }; }
    } else {
      result = { ok:false, error: `unknown method: ${msg.method}` };
    }
    wsSend(client, { type:'rpc_result', id: msg.id, ...result });
  } else if (msg.type === 'ping') {
    wsSend(client, { type:'pong', ts: Date.now() });
  }
}

// ── 3. publish / snapshot (和 server.js 一致) ────────────────────
function publish(topic, data) {
  const frame = JSON.stringify({ type:'event', topic, data, ts: Date.now() });
  const payload = Buffer.from(frame, 'utf8');
  for (const c of clients) {
    if (c.subs.has(topic)) wsSendRaw(c, 0x1, payload);
  }
}

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

function pushSnapshot(client, topic) {
  const fn = SNAPSHOTS[topic];
  if (!fn) return;
  try { wsSend(client, { type:'event', topic, data: fn(), ts: Date.now() }); }
  catch (e) { console.error('snapshot error', topic, e); }
}

const RPC = {
  'devices.toggle': ({ id }) => {
    const r = hub.toggleDevice(id);
    if (!r) return { ok:false, error:'device not found or locked' };
    publish(TOPICS.DEVICE_STATE, r);
    publish(TOPICS.DEVICES_LIST, hub.devicesSnapshot());
    return { ok:true, data: r };
  },
  'scene.run': ({ id, name_zh }) => {
    const label = name_zh || id;
    publish(TOPICS.VOICE_EVENT, { type:'said',  text:`"启动${label}模式"` });
    publish(TOPICS.VOICE_EVENT, { type:'reply', text:`好的，${label}模式已启动` });
    return { ok:true, data:{ id } };
  },
  'voice.greet': () => {
    publish(TOPICS.VOICE_EVENT, { type:'said',  text:'"小管家，你好"' });
    publish(TOPICS.VOICE_EVENT, { type:'reply', text:'你好！有什么可以帮你的？' });
    return { ok:true };
  },
};

// ── 4. Tickers ──────────────────────────────────────────────────
function ticker(topic, fn, interval) {
  setInterval(() => { try { publish(topic, fn()); } catch (e) { console.error(topic, e); } }, interval);
}
ticker(TOPICS.CLOCK,       hub.clockSnapshot,      TOPIC_TICK[TOPICS.CLOCK]);
ticker(TOPICS.ENV_INDOOR,  hub.envIndoorSnapshot,  TOPIC_TICK[TOPICS.ENV_INDOOR]);
ticker(TOPICS.ENV_OUTDOOR, hub.envOutdoorSnapshot, TOPIC_TICK[TOPICS.ENV_OUTDOOR]);
ticker(TOPICS.GW_STATUS,   openclaw.gatewaySnapshot,   TOPIC_TICK[TOPICS.GW_STATUS]);
ticker(TOPICS.LLM_STATUS,  claw.llmStatusSnapshot,     TOPIC_TICK[TOPICS.LLM_STATUS]);
ticker(TOPICS.NODES_LIST,  claw.nodesSnapshot,         TOPIC_TICK[TOPICS.NODES_LIST]);
ticker(TOPICS.VOICE_STATE, claw.voiceStateSnapshot,    TOPIC_TICK[TOPICS.VOICE_STATE] || 5_000);
ticker(TOPICS.ENERGY,      sys.energySnapshot,         TOPIC_TICK[TOPICS.ENERGY]);
ticker(TOPICS.SYS_SUMMARY, claw.sysSummarySnapshot,    TOPIC_TICK[TOPICS.SYS_SUMMARY]);
claw.onToolLogAppend((entry) => publish(TOPICS.TOOL_LOG_APPEND, entry));
setInterval(() => publish(TOPICS.WEATHER, hub.weatherSnapshot()), 60_000);

// ── 5. Boot ─────────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
  const host = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`\nSmart Home Hub (standalone, zero-dep)`);
  console.log(`  HTTP  http://${host}:${PORT}`);
  console.log(`  WS    ws://${host}:${PORT}/ws\n`);

  // 拉起 OpenClaw adapter（连不上也不阻塞）
  openclaw.start();
  claw.start();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { claw.stop(); openclaw.stop(); process.exit(0); });
}
