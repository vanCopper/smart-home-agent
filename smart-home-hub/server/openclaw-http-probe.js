// server/openclaw-http-probe.js
// ────────────────────────────────────────────────────────────────
// 一次性 HTTP 探测：loopback 下 Gateway 免鉴权 HTTP 端点扫描。
// 只发 GET，不改状态。每条打印 status + 响应大小 + 预览 400 字节。
//
// 用法：
//   node server/openclaw-http-probe.js
//   OPENCLAW_HTTP=http://127.0.0.1:18789 node server/openclaw-http-probe.js
// ────────────────────────────────────────────────────────────────

const BASE = process.env.OPENCLAW_HTTP || 'http://127.0.0.1:18789';

const CANDIDATES = [
  '/',
  '/health',
  '/healthz',
  '/status',
  '/liveness',
  '/readiness',
  '/metrics',
  '/info',
  '/version',
  '/v1',
  '/v1/health',
  '/v1/status',
  '/v1/models',
  '/v1/sessions',
  '/v1/nodes',
  '/v1/heartbeat',
  '/api',
  '/api/health',
  '/api/status',
  '/api/sessions',
  '/api/nodes',
  '/gateway',
  '/gateway/status',
  '/gateway/health',
  '/sessions',
  '/nodes',
  '/.well-known/openclaw',
];

const stamp = () => {
  const d = new Date(); const pad = (n, w=2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(),3)}`;
};
const log = (...a) => console.log(`[${stamp()}]`, ...a);

async function probeOne(path) {
  const url = BASE + path;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json, text/plain;q=0.9, */*;q=0.1' },
      signal: AbortSignal.timeout(3000),
    });
    const body = await res.text();
    const dt = Date.now() - t0;
    const ctype = res.headers.get('content-type') || '';
    const preview = body.length > 400 ? body.slice(0, 400) + '…' : body;
    return {
      path, status: res.status, dt, ctype,
      size: body.length,
      preview: preview.replace(/\s+/g, ' ').trim(),
    };
  } catch (e) {
    return { path, status: 'ERR', error: e.code || e.message, dt: Date.now() - t0 };
  }
}

(async () => {
  log(`→ target ${BASE}`);
  log(`→ probing ${CANDIDATES.length} paths`);
  const hits = [];
  for (const p of CANDIDATES) {
    const r = await probeOne(p);
    const tag =
      r.status === 'ERR'           ? '×'
      : r.status >= 200 && r.status < 300 ? '✓'
      : r.status >= 300 && r.status < 400 ? '↪'
      : r.status === 404            ? '·'
      : r.status === 401 || r.status === 403 ? '⛔'
      : '?';
    const rhs = r.status === 'ERR'
      ? `ERR ${r.error}`
      : `${r.status} ${r.ctype.split(';')[0]}  ${r.size}b  ${r.dt}ms`;
    console.log(`  ${tag} ${p.padEnd(28)}  ${rhs}`);
    if (r.status !== 'ERR' && r.status !== 404 && r.preview) {
      console.log(`     └─ ${r.preview}`);
    }
    if (typeof r.status === 'number' && r.status >= 200 && r.status < 300) hits.push(r);
  }
  log('');
  log(`═══ ${hits.length} usable endpoint(s) ═══`);
  for (const h of hits) log(`  ${h.path}  (${h.ctype})  → ${h.preview}`);
})();
