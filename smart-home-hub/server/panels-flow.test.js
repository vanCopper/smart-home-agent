// server/panels-flow.test.js
// ────────────────────────────────────────────────────────────────
// 端到端：把事件 fixture 喂进 openclaw-panels 的 handler，断言
// toolLogSnapshot / onToolLogAppend 行为正确。
// 不连 WS，不触发 openclaw.start()，纯内存。
//
// 跑法：node server/panels-flow.test.js
// ────────────────────────────────────────────────────────────────

import * as claw from './openclaw-panels.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else      { failed++; console.log(`  ✗ ${name}  ${detail}`); }
}

// ── case 1: tool_use → tool_result 配对 (session.message) ──

console.log('\n[flow 1] session.message tool_use + tool_result 配对');
claw._test.reset();

const appended = [];
claw.onToolLogAppend((entry) => appended.push({ ...entry }));

// 1) assistant 发 tool_use
claw._test.feedSessionMessage({
  sessionKey: 'agent:main:main',
  message: {
    role: 'assistant',
    content: [
      { type: 'text', text: 'looking that up' },
      { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.txt' } },
    ],
  },
});

check('append 触发一次', appended.length === 1);
check('log 含 1 条', claw.toolLogSnapshot().length === 1);
check('tool 名正确', claw.toolLogSnapshot()[0].tool === 'read_file');
check('status 初始 ok', claw.toolLogSnapshot()[0].status === 'ok');
check('latency 初始 0',  claw.toolLogSnapshot()[0].latency === 0);

// 2) user 发 tool_result
claw._test.feedSessionMessage({
  sessionKey: 'agent:main:main',
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents', durationMs: 42 },
    ],
  },
});

check('append 再触发一次（patch）', appended.length === 2);
check('log 仍然 1 条 (patch 就地更新)', claw.toolLogSnapshot().length === 1);
check('status 变 ok（已是 ok）', claw.toolLogSnapshot()[0].status === 'ok');
check('latency 更新到 42', claw.toolLogSnapshot()[0].latency === 42);
check('append payload 里 id 对得上', appended[1].id === 'tu_1' && appended[1].latency === 42);

// ── case 2: tool_result 失败 ──

console.log('\n[flow 2] tool_result is_error → fail');
claw._test.reset();

claw._test.feedSessionMessage({
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu_2', name: 'net.fetch', input: { url: 'x' } }],
  },
});
claw._test.feedSessionMessage({
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu_2', is_error: true, durationMs: 500 }],
  },
});

check('log 1 条', claw.toolLogSnapshot().length === 1);
check('status → fail', claw.toolLogSnapshot()[0].status === 'fail');
check('latency → 500', claw.toolLogSnapshot()[0].latency === 500);

// ── case 3: agent 事件路径 (假定 stream=tool) ──

console.log('\n[flow 3] agent stream=tool + stream=tool-result');
claw._test.reset();

claw._test.feedAgentEvent({
  stream: 'tool',
  data: { toolCallId: 'call_a', toolName: 'homeassistant.call', args: { entity: 'light.kitchen' } },
});
check('agent/tool → append 1 条', claw.toolLogSnapshot().length === 1);
check('tool 名 homeassistant.call', claw.toolLogSnapshot()[0].tool === 'homeassistant.call');

claw._test.feedAgentEvent({
  stream: 'tool-result',
  data: { toolCallId: 'call_a', durationMs: 88 },
});
check('agent/tool-result → patch，不新增', claw.toolLogSnapshot().length === 1);
check('latency 更新 88', claw.toolLogSnapshot()[0].latency === 88);

// ── case 4: noise 不产生条目 ──

console.log('\n[flow 4] 纯文本/lifecycle 不污染日志');
claw._test.reset();

claw._test.feedAgentEvent({ stream: 'lifecycle', data: { phase: 'start' } });
claw._test.feedAgentEvent({ stream: 'content', data: { text: 'hi' } });
claw._test.feedSessionMessage({
  message: { role: 'user', content: [{ type: 'text', text: 'do a thing' }] },
});
claw._test.feedSessionMessage({
  message: { role: 'assistant', content: [{ type: 'text', text: 'sure' }] },
});

check('噪音事件后 log 仍空', claw.toolLogSnapshot().length === 0);

// ── case 5: 同 id 重复 append 视为 patch (上游发了两次 tool_use) ──

console.log('\n[flow 5] 同 id 重复 → patch');
claw._test.reset();

claw._test.feedSessionMessage({
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'dup', name: 'a', input: {} }] },
});
claw._test.feedSessionMessage({
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'dup', name: 'a', input: { v: 1 } }] },
});
check('同 id 不新增', claw.toolLogSnapshot().length === 1);

// ── case 6: LOG_CAP 环形缓冲 ──

console.log('\n[flow 6] ring buffer 上限 50');
claw._test.reset();

for (let i = 0; i < 60; i++) {
  claw._test.feedSessionMessage({
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'x', input: {} }] },
  });
}
check('log 不超过 50 条', claw.toolLogSnapshot().length === 50);
check('最老条目被挤出（id=t0 不在）', !claw.toolLogSnapshot().find(x => x.id === 't0'));
check('最新条目在（id=t59 在）', !!claw.toolLogSnapshot().find(x => x.id === 't59'));

// ── case 7: 真实 OpenClaw session.tool 事件序列 ──
// 真实观察: update 事件里没有 meta；result 事件才带 meta（命令详情）。
// 所以 update 时 input 应该是空，result 时 patch 把 input 回填上。

console.log('\n[flow 7] 真实 session.tool update(无meta)+result(带meta) → input 回填 + 延迟 170ms');
claw._test.reset();

// update 先到 —— 真实事件没有 meta
claw._test.feedSessionTool({
  runId: 'r1', stream: 'tool', ts: 1776874520234,
  data: {
    phase: 'update', name: 'exec', toolCallId: 'call_abc',
    // 故意不给 meta, 保持真实 shape
  },
});

const afterUpdate = claw.toolLogSnapshot();
check('update → 1 条 running entry, input 暂为空', afterUpdate.length === 1
  && afterUpdate[0].id === 'call_abc'
  && afterUpdate[0].tool === 'exec'
  && afterUpdate[0].input === ''
  && afterUpdate[0].latency === 0);

// result 在 170ms 后到，携带 meta
claw._test.feedSessionTool({
  runId: 'r1', stream: 'tool', ts: 1776874520404,
  data: {
    phase: 'result', name: 'exec', toolCallId: 'call_abc',
    meta: 'run python bot.py status', isError: false,
  },
});

const afterResult = claw.toolLogSnapshot();
check('result → 仍 1 条（patch）', afterResult.length === 1);
check('result → latency 自动算出 170ms', afterResult[0].latency === 170);
check('result → status=ok', afterResult[0].status === 'ok');
check('result → input 被 meta 回填', afterResult[0].input === 'run python bot.py status');

// 同一 id 再来 result, isError=true 的场景
claw._test.reset();
claw._test.feedSessionTool({
  stream: 'tool', ts: 1000, data: { phase: 'update', name: 'exec', toolCallId: 'fail_x', meta: 'oops' },
});
claw._test.feedSessionTool({
  stream: 'tool', ts: 1250, data: { phase: 'result', name: 'exec', toolCallId: 'fail_x', isError: true },
});
const ff = claw.toolLogSnapshot();
check('isError=true → status=fail', ff[0].status === 'fail');
check('延迟 250ms', ff[0].latency === 250);

// ── 汇总 ──
console.log(`\n结果：${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
