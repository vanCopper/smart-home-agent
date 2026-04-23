// server/openclaw-bundle-scan.js
// ────────────────────────────────────────────────────────────────
// 反查 OpenClaw Control UI 的 API 端点。
//
// 思路：
//   1. GET http://127.0.0.1:18789/ 拿 SPA 主页 HTML
//   2. 提取所有 <script src> 和 <link href>（同时考虑相对/绝对路径）
//   3. 下载每个 bundle，在里面 grep 出可能的 API path + WS URL
//   4. 打印按路径去重后的命中，顺便给出 fetch/axios 调用上下文
//
// 用法:
//   node server/openclaw-bundle-scan.js
//   OPENCLAW_HTTP=http://127.0.0.1:18789 node server/openclaw-bundle-scan.js
// ────────────────────────────────────────────────────────────────

const BASE = (process.env.OPENCLAW_HTTP || 'http://127.0.0.1:18789').replace(/\/$/, '');
const TIMEOUT = 5000;

const stamp = () => {
  const d = new Date(); const p = (n, w=2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const log = (...a) => console.log(`[${stamp()}]`, ...a);

async function fetchText(url) {
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Accept': '*/*' },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await res.text();
  return { status: res.status, ctype: res.headers.get('content-type') || '', text, dt: Date.now() - t0 };
}

function resolveUrl(src, base) {
  try { return new URL(src, base).toString(); } catch { return null; }
}

// 从 HTML 里抠 <script src> 和 <link href>（只要 css/js/modulepreload）
function extractAssets(html, baseUrl) {
  const urls = new Set();
  const scriptRe = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  const linkRe   = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = scriptRe.exec(html))) { const u = resolveUrl(m[1], baseUrl); if (u) urls.add(u); }
  while ((m = linkRe.exec(html)))   { const u = resolveUrl(m[1], baseUrl); if (u) urls.add(u); }
  return [...urls];
}

// 在单个 asset 文本里找可能的端点
function scanAsset(text) {
  const hits = { paths: new Set(), wsUrls: new Set(), fetchCalls: new Set() };

  // 1) 形如 "/api/...", "/v1/...", "/rpc/...", "/sessions", "/tools", "/events", "/agent/..."
  //    不贪婪，到下一个引号/反引号/逗号/括号/空白为止
  const pathRe = /["'`](\/(?:api|v\d+|rpc|tool|tools|agent|agents|model|models|llm|session|sessions|log|logs|event|events|task|tasks|state|status|config|gateway|claw|openclaw|chat|message|messages|run|invoke|prompt|infer|ws|stream|sse)(?:\/[a-zA-Z0-9_\-./{}:]*)?)["'`]/g;
  let m;
  while ((m = pathRe.exec(text))) hits.paths.add(m[1]);

  // 2) WebSocket 连接
  const wsRe = /(?:new\s+WebSocket\s*\(\s*|WebSocket\s*\(\s*)["'`]([^"'`]+)["'`]/g;
  while ((m = wsRe.exec(text))) hits.wsUrls.add(m[1]);
  //   或者字面量里的 ws:// / wss://
  const wsLitRe = /["'`](wss?:\/\/[^"'`\s]+)["'`]/g;
  while ((m = wsLitRe.exec(text))) hits.wsUrls.add(m[1]);

  // 3) fetch("…") / fetch('…') / axios.get("…")
  const fetchRe = /(?:fetch|axios\.(?:get|post|put|delete|patch)|request)\s*\(\s*["'`]([^"'`]+)["'`]/g;
  while ((m = fetchRe.exec(text))) hits.fetchCalls.add(m[1]);

  return hits;
}

(async () => {
  log(`→ target ${BASE}`);

  // step 1: 主页
  let index;
  try {
    index = await fetchText(BASE + '/');
  } catch (e) {
    console.error(`! failed to fetch ${BASE}/:`, e.message);
    process.exit(1);
  }
  log(`→ / → ${index.status} ${index.ctype.split(';')[0]} ${index.text.length}b  ${index.dt}ms`);
  if (index.status !== 200) {
    console.error(`! index not 200, abort`);
    process.exit(2);
  }

  // 自身扫一遍（可能 inline script 已经暴露了）
  const selfHits = scanAsset(index.text);
  log(`→ inline in index.html: ${selfHits.paths.size} path(s), ${selfHits.wsUrls.size} ws, ${selfHits.fetchCalls.size} fetch`);

  // step 2: 抽 asset
  const assets = extractAssets(index.text, BASE + '/');
  log(`→ ${assets.length} linked asset(s)`);
  for (const u of assets) console.log(`   · ${u}`);

  // step 3: 下载 + 扫
  const paths = new Set(selfHits.paths);
  const wsUrls = new Set(selfHits.wsUrls);
  const fetchCalls = new Set(selfHits.fetchCalls);

  for (const url of assets) {
    let r;
    try { r = await fetchText(url); }
    catch (e) { console.warn(`   × ${url} → ${e.message}`); continue; }
    if (r.status !== 200) { console.warn(`   × ${url} → ${r.status}`); continue; }
    const hits = scanAsset(r.text);
    console.log(`   ✓ ${url.replace(BASE, '')}  [${r.text.length}b]  p=${hits.paths.size} ws=${hits.wsUrls.size} f=${hits.fetchCalls.size}`);
    for (const p of hits.paths) paths.add(p);
    for (const w of hits.wsUrls) wsUrls.add(w);
    for (const f of hits.fetchCalls) fetchCalls.add(f);
  }

  // step 4: 打印
  console.log('');
  console.log('═══ API path candidates ═══');
  [...paths].sort().forEach(p => console.log(`   ${p}`));
  console.log('');
  console.log('═══ WebSocket endpoints ═══');
  [...wsUrls].sort().forEach(u => console.log(`   ${u}`));
  console.log('');
  console.log('═══ fetch/axios call URLs ═══');
  [...fetchCalls].sort().forEach(u => console.log(`   ${u}`));
  console.log('');
  log(`done — ${paths.size} paths, ${wsUrls.size} ws, ${fetchCalls.size} fetch`);
})();
