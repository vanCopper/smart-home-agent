// server/openclaw-probe.js
// ────────────────────────────────────────────────────────────────
// 一次性探测脚本：生成/加载持久化 Ed25519 身份，依次尝试多种
// device 块签名编码，找到 Gateway 接受的那套，并打印 hello-ok
// + 5s 事件样本。
//
// 身份文件保存在 ~/.openclaw/smart-home-hub/identity.json，
// 首次生成后会被 Gateway 在 loopback 模式下自动批准。
// ────────────────────────────────────────────────────────────────

import { WebSocket }   from 'ws';
import crypto          from 'node:crypto';
import fs              from 'node:fs';
import path            from 'node:path';
import os              from 'node:os';

const URL    = process.env.OPENCLAW_WS    || 'ws://127.0.0.1:18789';
const TOKEN  = process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_TOKEN || '';
const IDENTITY_DIR  = path.join(os.homedir(), '.openclaw', 'smart-home-hub');
const IDENTITY_PATH = path.join(IDENTITY_DIR, 'identity.json');

// ── 身份管理（Ed25519）─────────────────────────────────────────
function loadOrCreateIdentity() {
  if (fs.existsSync(IDENTITY_PATH)) {
    const j = JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf-8'));
    const priv = crypto.createPrivateKey({
      key: Buffer.from(j.privateKeyPkcs8Base64, 'base64'),
      format: 'der', type: 'pkcs8',
    });
    const pub = crypto.createPublicKey(priv);
    const rawPub = pub.export({ format: 'der', type: 'spki' }).slice(-32);
    return {
      priv, pub, rawPubHex: rawPub.toString('hex'),
      rawPubBase64: rawPub.toString('base64'),
      idHex: crypto.createHash('sha256').update(rawPub).digest('hex'),
      createdAt: j.createdAt,
      source: 'disk',
    };
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ format: 'der', type: 'spki' }).slice(-32);
  const privPkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  fs.mkdirSync(IDENTITY_DIR, { recursive: true });
  fs.writeFileSync(IDENTITY_PATH, JSON.stringify({
    privateKeyPkcs8Base64: privPkcs8.toString('base64'),
    publicKeyRawHex:       rawPub.toString('hex'),
    deviceIdHex:           crypto.createHash('sha256').update(rawPub).digest('hex'),
    createdAt:             Date.now(),
  }, null, 2), { mode: 0o600 });
  return {
    priv: privateKey, pub: publicKey,
    rawPubHex: rawPub.toString('hex'),
    rawPubBase64: rawPub.toString('base64'),
    idHex: crypto.createHash('sha256').update(rawPub).digest('hex'),
    createdAt: Date.now(),
    source: 'new',
  };
}

function sign(priv, bytes) {
  return crypto.sign(null, bytes, priv);
}

const rid   = () => 'p-' + crypto.randomBytes(4).toString('hex');
const stamp = () => {
  const d = new Date(); const pad = (n, w=2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(),3)}`;
};
const log   = (...a) => console.log(`[${stamp()}]`, ...a);

const id = loadOrCreateIdentity();
log(`→ identity (${id.source})  id=${id.idHex.slice(0,16)}…  pub=${id.rawPubHex.slice(0,16)}…`);
log(`   file: ${IDENTITY_PATH}`);
log(`→ target ${URL}${TOKEN ? ' (with token)' : ' (no token)'}`);

// ── 构造不同 device 块的策略 —————————————————————————————
// 已确认：publicKey = base64(raw_pub), id = hex(sha256(raw_pub)), signature = base64(sig)
// 唯一变量：被签名的 bytes 是什么。
function buildDevice(strategy, nonce, challengeTs) {
  const signedAt = Date.now();
  const utf8 = (s) => Buffer.from(s, 'utf-8');
  const base = { id: id.idHex, publicKey: id.rawPubBase64, signedAt, nonce };

  const msg = (() => {
    switch (strategy) {
      case 'nonce':                   return utf8(nonce);
      case 'nonce+signedAt':          return utf8(`${nonce}${signedAt}`);
      case 'nonce+challengeTs':       return utf8(`${nonce}${challengeTs}`);
      case 'nonce:signedAt':          return utf8(`${nonce}:${signedAt}`);
      case 'nonce:challengeTs':       return utf8(`${nonce}:${challengeTs}`);
      case 'signedAt+nonce':          return utf8(`${signedAt}${nonce}`);
      case 'id:nonce':                return utf8(`${id.idHex}:${nonce}`);
      case 'id:nonce:signedAt':       return utf8(`${id.idHex}:${nonce}:${signedAt}`);
      case 'id:pub:nonce':            return utf8(`${id.idHex}:${id.rawPubBase64}:${nonce}`);
      case 'pub:nonce':               return utf8(`${id.rawPubBase64}:${nonce}`);
      case 'connect:nonce':           return utf8(`connect:${nonce}`);
      case 'connect:nonce:signedAt':  return utf8(`connect:${nonce}:${signedAt}`);
      case 'openclaw:connect:nonce':  return utf8(`openclaw:connect:${nonce}`);
      case 'device-auth:nonce':       return utf8(`device-auth:${nonce}`);
      case 'json-nonce':              return utf8(JSON.stringify({ nonce }));
      case 'json-nonce-ts':           return utf8(JSON.stringify({ nonce, ts: challengeTs }));
      case 'json-nonce-signedAt':     return utf8(JSON.stringify({ nonce, signedAt }));
      case 'json-id-nonce-signedAt':  return utf8(JSON.stringify({ id: id.idHex, nonce, signedAt }));
      case 'json-canon-all':          return utf8(JSON.stringify({ id: id.idHex, nonce, publicKey: id.rawPubBase64, signedAt }));
      case 'hex-nonce-bytes':         return Buffer.from(nonce.replace(/-/g, ''), 'hex');
      case 'sha256-nonce':            return crypto.createHash('sha256').update(utf8(nonce)).digest();
    }
    throw new Error('unknown strategy ' + strategy);
  })();

  return { ...base, signature: sign(id.priv, msg).toString('base64') };
}

async function tryStrategy(strategy) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL, { handshakeTimeout: 5000 });
    const reqId = rid();
    let challengeNonce = null, challengeTs = null, done = false;
    const finish = (r) => { if (done) return; done = true; try { ws.close(); } catch{}; resolve(r); };
    const to = setTimeout(() => finish({ ok: false, error: 'timeout' }), 7000);

    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'event' && m.event === 'connect.challenge') {
        challengeNonce = m.payload?.nonce;
        challengeTs    = m.payload?.ts;
        const device = buildDevice(strategy, challengeNonce, challengeTs);
        ws.send(JSON.stringify({
          type: 'req', id: reqId, method: 'connect',
          params: {
            minProtocol: 3, maxProtocol: 3, role: 'operator',
            scopes: ['operator.read'],
            client: { id: 'cli', version: '0.1.0', platform: 'macos', mode: 'cli' },
            device,
            ...(TOKEN ? { auth: { token: TOKEN } } : {}),
            locale: 'zh-CN', userAgent: 'smart-home-hub/probe',
          },
        }));
      }
      if (m.type === 'res' && m.id === reqId) {
        clearTimeout(to);
        if (m.ok) finish({ ok: true, payload: m.payload });
        else      finish({ ok: false, error: m.error, closeCode: null });
      }
    });
    ws.on('close', (code, reason) => {
      clearTimeout(to);
      finish({ ok: false, error: { message: reason?.toString() || `closed ${code}` }, closeCode: code });
    });
    ws.on('error', () => {}); // close will follow
  });
}

async function listen5s() {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL, { handshakeTimeout: 4000 });
    const reqId = rid();
    const events = []; let helloOk = null;
    const stop = () => { try { ws.close(); } catch{}; resolve({ helloOk, events }); };
    setTimeout(stop, 5500);
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'event' && m.event === 'connect.challenge') {
        const device = buildDevice(WORKING_STRATEGY, m.payload?.nonce, m.payload?.ts);
        ws.send(JSON.stringify({
          type: 'req', id: reqId, method: 'connect',
          params: {
            minProtocol: 3, maxProtocol: 3, role: 'operator', scopes: ['operator.read'],
            client: { id: 'cli', version: '0.1.0', platform: 'macos', mode: 'cli' },
            device, ...(TOKEN ? { auth: { token: TOKEN } } : {}), locale: 'zh-CN',
          },
        }));
      } else if (m.type === 'res' && m.id === reqId && m.ok) helloOk = m.payload;
      else if (m.type === 'event') events.push({ event: m.event, payload: m.payload });
    });
    ws.on('close', stop);
  });
}

let WORKING_STRATEGY = null;

(async () => {
  const STRATEGIES = [
    // 已验证 publicKey=b64, id=hex(sha256), signature=b64。只枚举「签什么 bytes」
    'nonce',                  // baseline（上次失败）
    'nonce+signedAt',
    'nonce:signedAt',
    'nonce+challengeTs',
    'nonce:challengeTs',
    'signedAt+nonce',
    'id:nonce',
    'id:nonce:signedAt',
    'id:pub:nonce',
    'pub:nonce',
    'connect:nonce',
    'connect:nonce:signedAt',
    'openclaw:connect:nonce',
    'device-auth:nonce',
    'json-nonce',
    'json-nonce-ts',
    'json-nonce-signedAt',
    'json-id-nonce-signedAt',
    'json-canon-all',
    'hex-nonce-bytes',
    'sha256-nonce',
  ];
  for (const s of STRATEGIES) {
    const r = await tryStrategy(s);
    if (r.ok) {
      log(`✓ WORKING: ${s}`);
      WORKING_STRATEGY = s;
      const p = r.payload || {};
      log('═══ hello-ok ═══');
      log('  protocol       :', p.protocol);
      log('  server.version :', p.server?.version);
      log('  tickIntervalMs :', p.policy?.tickIntervalMs);
      log('  auth.role      :', p.auth?.role);
      log('  auth.scopes    :', p.auth?.scopes);
      log('  has deviceToken:', !!p.auth?.deviceToken);
      log('  features.events [sample]:', (p.features?.events  || []).slice(0, 30));
      log('  features.methods[sample]:', (p.features?.methods || []).slice(0, 30));
      log('  snapshot keys  :', p.snapshot ? Object.keys(p.snapshot) : '(none)');
      if (p.snapshot) log('  snapshot raw   :', JSON.stringify(p.snapshot).slice(0, 400));
      break;
    }
    const errStr = typeof r.error === 'string' ? r.error : JSON.stringify(r.error);
    log(`✗ ${s}  → ${errStr.slice(0, 300)}${r.closeCode ? `  (close=${r.closeCode})`:''}`);
  }

  if (!WORKING_STRATEGY) {
    log('');
    log('— 所有签名策略都失败。可能的下一步：');
    log('  1) 拿到官方 openclaw CLI 已经在用的 device 私钥 path，直接复用');
    log('  2) 去官方 issue 确认签名字节的精确格式');
    log('  3) 贴出上面每条 ✗ 后面的 error，我会进一步缩小');
    process.exit(1);
  }

  log('');
  log('═══ 5s event sample ═══');
  const { events } = await listen5s();
  const byType = {};
  for (const e of events) byType[e.event] = (byType[e.event] || 0) + 1;
  log('  event counts:', byType);
  for (const e of events.slice(0, 10)) {
    log(`    • ${e.event}:`, JSON.stringify(e.payload).slice(0, 280));
  }
  log('');
  log(`=> 写进 adapter 的配置: strategy="${WORKING_STRATEGY}"  identity=${IDENTITY_PATH}`);
  process.exit(0);
})();
