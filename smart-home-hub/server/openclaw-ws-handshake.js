// server/openclaw-ws-handshake.js
// ────────────────────────────────────────────────────────────────
// 连续试多种"伪装 Control UI"的握手策略，看 gateway.controlUi.*
// 的 bypass flag 按哪种特征触发。
//
// 每一轮都发一个不带 device 块的 connect，看返回。成功立刻停手。
//
// 跑法：
//   node server/openclaw-ws-handshake.js
// ────────────────────────────────────────────────────────────────

import { WebSocket } from 'ws';

const WS_BASE  = process.env.OPENCLAW_WS  || 'ws://127.0.0.1:18789';
const HTTP_BASE = process.env.OPENCLAW_HTTP || 'http://127.0.0.1:18789';
const TIMEOUT_MS = 4_000;

const stamp = () => {
  const d = new Date(); const p = (n, w=2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(),3)}`;
};
const log = (...a) => console.log(`[${stamp()}]`, ...a);

const PLATFORM = process.platform === 'darwin' ? 'macos'
                : process.platform === 'linux'  ? 'linux'
                : process.platform === 'win32'  ? 'windows'
                : process.platform;

function connectParams(extra = {}) {
  return {
    minProtocol: 3,
    maxProtocol: 3,
    client: { id: 'cli', version: '0.0.1', platform: PLATFORM, mode: 'cli' },
    role: 'operator',
    scopes: ['operator.read'],
    ...extra,
  };
}

const TOKEN = '51fa18932a295d0da96c0afe374cf8b2c383eb76894350f6';

// 五种策略：逐个试
const STRATEGIES = [
  {
    name: 'A) plain — 无 device、无 Origin、无 token',
    url: WS_BASE,
    opts: {},
    params: connectParams(),
  },
  {
    name: 'B) Origin header = Control UI 源',
    url: WS_BASE,
    opts: { headers: { Origin: HTTP_BASE } },
    params: connectParams(),
  },
  {
    name: 'C) Origin + auth.token from config',
    url: WS_BASE,
    opts: { headers: { Origin: HTTP_BASE } },
    params: connectParams({ auth: { token: TOKEN } }),
  },
  {
    name: 'D) Path /control-ui/ws + Origin',
    url: `${WS_BASE}/control-ui/ws`,
    opts: { headers: { Origin: HTTP_BASE } },
    params: connectParams(),
  },
  {
    name: 'E) Origin + Referer + Sec-WebSocket-Protocol',
    url: WS_BASE,
    opts: {
      headers: {
        Origin: HTTP_BASE,
        Referer: `${HTTP_BASE}/`,
      },
      protocol: 'openclaw.control-ui',
    },
    params: connectParams(),
  },
];

function tryOnce(strategy) {
  return new Promise((resolve) => {
    log(`\n═══ ${strategy.name}`);
    log(`  url=${strategy.url}${strategy.opts.headers ? `  headers=${JSON.stringify(strategy.opts.headers)}` : ''}${strategy.opts.protocol ? `  subprotocol=${strategy.opts.protocol}` : ''}`);
    let ws;
    try {
      const { protocol, ...rest } = strategy.opts;
      ws = protocol ? new WebSocket(strategy.url, protocol, rest) : new WebSocket(strategy.url, rest);
    }
    catch (e) { resolve({ ok:false, kind:'open-throw', detail:e.message }); return; }

    const reqId = `hs-${Date.now()}`;
    const frames = [];
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch {}
      resolve({ ok:false, kind:'timeout', frames });
    }, TIMEOUT_MS);

    ws.on('open', () => log(`  ws open`));
    ws.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok:false, kind:'ws-error', detail:e.code || e.message, frames });
    });
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      resolve({ ok:false, kind:'http', status:res.statusCode, headers:res.headers });
    });
    ws.on('close', (code, reason) => {
      log(`  ws close  code=${code}  reason=${reason?.toString() || ''}`);
    });
    ws.on('message', (buf) => {
      const raw = buf.toString('utf8');
      let msg; try { msg = JSON.parse(raw); } catch { log('  ← non-json', raw); return; }
      frames.push(msg);
      log(`  ← ${JSON.stringify(msg)}`);
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        // server 的 nonce 不放 params 根，schema 不认；只有有 device 块时才放 device.nonce
        const req = { type:'req', id:reqId, method:'connect', params: strategy.params };
        log(`  → ${JSON.stringify(req)}`);
        ws.send(JSON.stringify(req));
      } else if (msg.type === 'res' && msg.id === reqId) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve({ ok: !!msg.ok, kind:'res', res:msg, frames });
      }
    });
  });
}

(async () => {
  log(`→ target ${WS_BASE}`);
  for (const s of STRATEGIES) {
    const r = await tryOnce(s);
    if (r.ok) {
      console.log(`\n✓ SUCCESS with strategy: ${s.name}`);
      console.log('  payload:', JSON.stringify(r.res.payload, null, 2));
      console.log(`\n>>> 记录下这一组 { url, headers, params.client.mode } 就是我们后续 adapter 要用的握手配方 <<<\n`);
      process.exit(0);
    } else {
      console.log(`  × ${r.kind}${r.detail ? ` (${r.detail})` : ''}${r.status ? ` http ${r.status}` : ''}`);
      if (r.res) console.log(`    error code=${r.res.error?.code || '?'}  msg=${r.res.error?.message || '?'}`);
    }
  }
  console.log('\n✗ 所有策略都没通。把上面 5 轮输出整段贴回来。');
  process.exit(1);
})();
