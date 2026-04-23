// server/openclaw-rpc-probe.js
// ────────────────────────────────────────────────────────────────
// 用 openclaw.js 的长连客户端把 LLM / Voice / Tool / Session 相关
// RPC 全调一遍，打印真实返回 shape。后面 snapshot 函数照这个写。
//
//   node server/openclaw-rpc-probe.js
// ────────────────────────────────────────────────────────────────

import * as openclaw from './openclaw.js';

const METHODS = [
  ['models.list',     {}],
  ['usage.status',    {}],
  ['usage.cost',      {}],
  ['voicewake.get',   {}],
  ['talk.mode',       {}],    // 读
  ['talk.config',     {}],
  ['tools.catalog',   {}],
  ['tools.effective', {}],
  ['sessions.list',   {}],
  ['status',          {}],
  ['agents.list',     {}],
  ['gateway.identity.get', {}],
  ['channels.status', {}],
];

const stamp = () => {
  const d = new Date(); const p = n => String(n).padStart(2,'0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const log = (...a) => console.log(`[${stamp()}]`, ...a);

function waitConnected(timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (openclaw.isConnected()) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error('connect timeout'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

(async () => {
  openclaw.start();
  try { await waitConnected(); }
  catch (e) { console.error('! not connected:', e.message); process.exit(1); }

  for (const [method, params] of METHODS) {
    try {
      const r = await openclaw.rpc(method, params, 3_000);
      console.log(`\n▲ ${method}`);
      console.log(JSON.stringify(r, null, 2));
    } catch (e) {
      console.log(`\n▲ ${method}  × ${e.code || ''} ${e.message}`);
    }
  }

  console.log('\n— done —');
  openclaw.stop();
  setTimeout(() => process.exit(0), 200);
})();
