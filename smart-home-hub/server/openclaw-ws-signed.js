// server/openclaw-ws-signed.js
// ────────────────────────────────────────────────────────────────
// OpenClaw Gateway WS v3 正规签名握手探测。
//
// 目标：按源码里抠出的 v3 payload 公式
//   v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily
// 生成 Ed25519 keypair，签名，成功通过 connect。
//
// 身份持久化在 ~/.openclaw/smart-home-hub/identity.json，跑完这次
// 之后 deviceId / pubkey / privkey 都复用；gateway 侧第一次会拒
// (NOT_PAIRED) —— 这时需要在 OpenClaw 里把 deviceId 加白或走配对
// 流程。看到 NOT_PAIRED 就把它的 deviceId 抄到 gateway 白名单。
//
// 环境变量：
//   OPENCLAW_WS     默认 ws://127.0.0.1:18789
//   OPENCLAW_TOKEN  默认空；v3 公式里 token 段。auth.mode=none 时
//                   一般用空串；如果 gateway 仍然要求匹配，把配置
//                   里的 auth.token 值填进来再试。
//
// 跑法：
//   node server/openclaw-ws-signed.js
// ────────────────────────────────────────────────────────────────

import { WebSocket } from 'ws';
import { createHash, generateKeyPairSync, sign as edSign, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const WS_URL = process.env.OPENCLAW_WS || 'ws://127.0.0.1:18789';
const TOKEN  = process.env.OPENCLAW_TOKEN ?? '';
const TIMEOUT_MS = 6_000;

const IDENTITY_PATH = join(homedir(), '.openclaw', 'smart-home-hub', 'identity.json');

const PLATFORM = process.platform === 'darwin' ? 'macos'
                : process.platform === 'linux'  ? 'linux'
                : process.platform === 'win32'  ? 'windows'
                : process.platform;
const DEVICE_FAMILY = 'desktop';
const CLIENT_ID     = 'cli';
const CLIENT_MODE   = 'cli';
const CLIENT_VERSION = '0.0.1';
const ROLE = 'operator';
const SCOPES = ['operator.read'];

const stamp = () => {
  const d = new Date(); const p = (n, w=2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(),3)}`;
};
const log = (...a) => console.log(`[${stamp()}]`, ...a);

// ──────────────────────────────────────────────────────────
// 身份：Ed25519 keypair + deviceId（sha256 hex of raw pubkey）
// ──────────────────────────────────────────────────────────

function rawPubBytesOf(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  // jwk.x 是 base64url 编码的 raw 32 bytes
  return Buffer.from(jwk.x, 'base64url');
}

function loadOrCreateIdentity() {
  if (existsSync(IDENTITY_PATH)) {
    try {
      const j = JSON.parse(readFileSync(IDENTITY_PATH, 'utf8'));
      if (j.privateKeyPem && j.publicKeyB64 && j.deviceId) {
        const privateKey = createPrivateKey(j.privateKeyPem);
        const publicKey  = createPublicKey(privateKey);
        log(`→ identity loaded from ${IDENTITY_PATH}`);
        log(`  deviceId   = ${j.deviceId}`);
        log(`  publicKey  = ${j.publicKeyB64}`);
        return { privateKey, publicKey, deviceId: j.deviceId, publicKeyB64: j.publicKeyB64 };
      }
    } catch (e) {
      console.warn(`! identity file corrupt (${e.message}), regenerating`);
    }
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const rawPub = rawPubBytesOf(publicKey);
  const publicKeyB64 = rawPub.toString('base64');
  const deviceId = createHash('sha256').update(rawPub).digest('hex'); // lowercase hex
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  mkdirSync(dirname(IDENTITY_PATH), { recursive: true });
  writeFileSync(IDENTITY_PATH, JSON.stringify({
    deviceId, publicKeyB64, privateKeyPem,
    createdAt: new Date().toISOString(),
  }, null, 2), 'utf8');
  log(`→ identity created & saved to ${IDENTITY_PATH}`);
  log(`  deviceId   = ${deviceId}`);
  log(`  publicKey  = ${publicKeyB64}`);
  return { privateKey, publicKey, deviceId, publicKeyB64 };
}

function signV3({ privateKey, deviceId, signedAtMs, nonce }) {
  const payload = [
    'v3',
    deviceId,
    CLIENT_ID,
    CLIENT_MODE,
    ROLE,
    SCOPES.join(','),
    String(signedAtMs),
    TOKEN,
    nonce,
    PLATFORM,
    DEVICE_FAMILY,
  ].join('|');
  const sigBuf = edSign(null, Buffer.from(payload, 'utf8'), privateKey);
  const sigB64 = sigBuf.toString('base64');
  return { payload, sigB64 };
}

// ──────────────────────────────────────────────────────────
// 握手主流程
// ──────────────────────────────────────────────────────────

function buildConnectParams({ deviceId, publicKeyB64, signature, signedAt, nonce }) {
  return {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: CLIENT_ID,
      version: CLIENT_VERSION,
      platform: PLATFORM,
      mode: CLIENT_MODE,
      deviceFamily: DEVICE_FAMILY,
    },
    role: ROLE,
    scopes: SCOPES,
    device: {
      id: deviceId,
      publicKey: publicKeyB64,
      signature,
      signedAt,
      nonce,
    },
  };
}

async function handshake() {
  const id = loadOrCreateIdentity();

  return new Promise((resolve) => {
    log(`→ connecting ${WS_URL}`);
    const ws = new WebSocket(WS_URL);
    const reqId = `hs-${Date.now()}`;
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch {}
      resolve({ ok: false, kind: 'timeout' });
    }, TIMEOUT_MS);

    ws.on('open',  () => log('  ws open'));
    ws.on('close', (code, reason) => log(`  ws close  code=${code}  reason=${reason?.toString() || ''}`));
    ws.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, kind: 'ws-error', detail: e.code || e.message });
    });
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      resolve({ ok: false, kind: 'http', status: res.statusCode, headers: res.headers });
    });

    ws.on('message', (buf) => {
      const raw = buf.toString('utf8');
      let msg; try { msg = JSON.parse(raw); } catch { log('  ← non-json', raw); return; }
      log(`  ← ${JSON.stringify(msg)}`);

      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        const nonce = msg.payload?.nonce || msg.data?.nonce || msg.nonce;
        if (!nonce) {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          resolve({ ok: false, kind: 'no-nonce', frame: msg });
          return;
        }
        const signedAt = Date.now();
        const { payload, sigB64 } = signV3({
          privateKey: id.privateKey,
          deviceId:   id.deviceId,
          signedAtMs: signedAt,
          nonce,
        });
        log(`  ∙ v3 payload = ${payload}`);
        log(`  ∙ signature  = ${sigB64}`);
        const params = buildConnectParams({
          deviceId:     id.deviceId,
          publicKeyB64: id.publicKeyB64,
          signature:    sigB64,
          signedAt,
          nonce,
        });
        const req = { type: 'req', id: reqId, method: 'connect', params };
        log(`  → ${JSON.stringify(req)}`);
        ws.send(JSON.stringify(req));
      } else if (msg.type === 'res' && msg.id === reqId) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve({ ok: !!msg.ok, kind: 'res', res: msg });
      }
    });
  });
}

(async () => {
  log(`→ target ${WS_URL}`);
  log(`→ token  = ${TOKEN ? `(${TOKEN.length} chars)` : '(empty)'}`);
  log(`→ platform=${PLATFORM}  deviceFamily=${DEVICE_FAMILY}`);

  const r = await handshake();
  if (r.ok) {
    console.log('\n✓ CONNECT OK');
    console.log('  payload:', JSON.stringify(r.res.payload, null, 2));
    console.log('\n>>> 把 identity.json 里的 deviceId 抄下来，用作 openclaw-ws.js 长连的身份。');
    process.exit(0);
  } else {
    console.log(`\n✗ FAILED — kind=${r.kind}`);
    if (r.detail) console.log(`  detail: ${r.detail}`);
    if (r.status) console.log(`  http status: ${r.status}`);
    if (r.res) {
      console.log(`  res.ok = ${r.res.ok}`);
      console.log(`  res.error = ${JSON.stringify(r.res.error)}`);
      if (r.res.payload) console.log(`  res.payload = ${JSON.stringify(r.res.payload)}`);
    }
    if (r.frame) console.log(`  frame: ${JSON.stringify(r.frame)}`);
    console.log('\n>>> 如果是 NOT_PAIRED，把上面 identity 里的 deviceId 加到 OpenClaw gateway 配对白名单里再重跑。');
    console.log('>>> 如果是 INVALID_SIGNATURE，有可能是 token 段：OPENCLAW_TOKEN=<配置里的 auth.token> node server/openclaw-ws-signed.js');
    process.exit(1);
  }
})();
