// server/tool-log-parse.test.js
// ────────────────────────────────────────────────────────────────
// 跑法：  node server/tool-log-parse.test.js
// 断言通过静默退出 (exit 0)，任一 case fail 整体 exit 1。
// 无依赖、无网络、可在任何机器上跑，用来在接入真实事件流前把解析器自证清白。
// ────────────────────────────────────────────────────────────────

import {
  payloadToToolEntry,
  agentEventToTool,
  sessionMessageToTools,
  sessionToolEventToAction,
} from './tool-log-parse.js';

const NOW = new Date('2026-04-21T10:30:45Z');
let passed = 0, failed = 0;

function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else      { failed++; console.log(`  ✗ ${name}  ${detail}`); }
}

// ── group 1: payloadToToolEntry (session.tool 形状 / 通用底料) ──

console.log('\n[group 1] payloadToToolEntry — 通用/session.tool');

check('null → null', payloadToToolEntry(null) === null);
check('empty obj → null (无工具名)', payloadToToolEntry({}) === null);
check('只有 tool string → entry', (() => {
  const e = payloadToToolEntry({ tool: 'read_file', input: 'path=foo.txt' }, NOW);
  return e && e.tool === 'read_file' && e.input === 'path=foo.txt' && e.status === 'ok';
})());
check('tool.name + args object → 序列化', (() => {
  const e = payloadToToolEntry({ tool: { name: 'http.get' }, args: { url: 'a.com' } }, NOW);
  return e && e.tool === 'http.get' && e.input === '{"url":"a.com"}';
})());
check('80+ chars input 截断带省略号', (() => {
  const e = payloadToToolEntry({ tool: 'x', input: 'a'.repeat(100) }, NOW);
  // 77 字符 + '…' = 78 chars 总长
  return e && e.input.length === 78 && e.input.endsWith('…');
})());
check('status=fail 透传', (() => {
  const e = payloadToToolEntry({ tool: 'x', status: 'fail' }, NOW);
  return e && e.status === 'fail';
})());
check('error 字段 → fail', (() => {
  const e = payloadToToolEntry({ tool: 'x', error: 'boom' }, NOW);
  return e && e.status === 'fail';
})());
check('durationMs → latency', (() => {
  const e = payloadToToolEntry({ tool: 'x', durationMs: 123 }, NOW);
  return e && e.latency === 123;
})());
check('id 优先用 toolCallId', (() => {
  const e = payloadToToolEntry({ tool: 'x', toolCallId: 'call_42' }, NOW);
  return e && e.id === 'call_42';
})());

// ── group 2: agentEventToTool ──

console.log('\n[group 2] agentEventToTool — agent 事件');

check('lifecycle → null', agentEventToTool({
  stream: 'lifecycle', data: { phase: 'start' },
}) === null);

check('stream=tool 带 toolName → entry', (() => {
  const r = agentEventToTool({
    stream: 'tool',
    data: { toolName: 'homeassistant.call', toolCallId: 'x', args: { entity: 'light.kitchen' } },
    runId: 'run-1',
  }, NOW);
  return r && r.kind === 'entry'
    && r.entry.tool === 'homeassistant.call'
    && r.entry.input.includes('light.kitchen');
})());

check('stream=tool-result 只带 id + durationMs → patch', (() => {
  const r = agentEventToTool({
    stream: 'tool-result',
    data: { toolCallId: 'call_a', durationMs: 88 },
  }, NOW);
  return r && r.kind === 'patch'
    && r.patch.id === 'call_a'
    && r.patch.status === 'ok'
    && r.patch.latency === 88;
})());

check('stream=tool-result with error → patch fail', (() => {
  const r = agentEventToTool({
    stream: 'tool-result',
    data: { toolCallId: 'call_a', error: 'timeout', durationMs: 3200 },
  }, NOW);
  return r && r.kind === 'patch' && r.patch.status === 'fail' && r.patch.latency === 3200;
})());

check('stream=content 但 data 里有 tool_use_id + name → entry', (() => {
  const r = agentEventToTool({
    stream: 'content',
    data: { tool_use_id: 'tu_1', name: 'read_file', input: { path: 'a.txt' }, args: { path: 'a.txt' } },
  }, NOW);
  return r && r.kind === 'entry' && r.entry.tool === 'read_file' && r.entry.id === 'tu_1';
})());

check('stream=content 普通文字 → null', agentEventToTool({
  stream: 'content',
  data: { text: 'hello' },
}) === null);

check('无 data 字段 → null', agentEventToTool({ stream: 'tool' }) === null);

// ── group 3: sessionMessageToTools ──

console.log('\n[group 3] sessionMessageToTools — session.message');

check('纯文本 assistant → 空', (() => {
  const r = sessionMessageToTools({
    message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  }, NOW);
  return r.entries.length === 0 && r.patches.length === 0;
})());

check('tool_use block → 1 entry', (() => {
  const r = sessionMessageToTools({
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me check' },
        { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.txt' } },
      ],
    },
  }, NOW);
  return r.entries.length === 1
      && r.entries[0].id === 'tu_1'
      && r.entries[0].tool === 'read_file'
      && r.entries[0].input.includes('a.txt');
})());

check('两个 tool_use block → 2 entries', (() => {
  const r = sessionMessageToTools({
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't1', name: 'a', input: {} },
        { type: 'tool_use', id: 't2', name: 'b', input: {} },
      ],
    },
  }, NOW);
  return r.entries.length === 2 && r.entries[0].id === 't1' && r.entries[1].id === 't2';
})());

check('tool_result block → 1 patch, ok', (() => {
  const r = sessionMessageToTools({
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'done', durationMs: 88 }],
    },
  }, NOW);
  return r.entries.length === 0
      && r.patches.length === 1
      && r.patches[0].id === 'tu_1'
      && r.patches[0].status === 'ok'
      && r.patches[0].latency === 88;
})());

check('tool_result with is_error → fail', (() => {
  const r = sessionMessageToTools({
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: true }],
    },
  }, NOW);
  return r.patches[0].status === 'fail';
})());

check('role=tool 整条消息 → patch', (() => {
  const r = sessionMessageToTools({
    message: { role: 'tool', tool_call_id: 'tc_7', content: 'ok', durationMs: 30 },
  }, NOW);
  return r.patches.length === 1 && r.patches[0].id === 'tc_7' && r.patches[0].latency === 30;
})());

check('payload.message 缺省，直接传 message 字段也能解', (() => {
  const r = sessionMessageToTools({
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'x', name: 'y', input: {} }],
  }, NOW);
  return r.entries.length === 1 && r.entries[0].id === 'x';
})());

// ── group 4: 回归已观察到的真实 payload ──
// 这是 vancopper 日志里真实出现过的 cron ETH 机器人启动事件
// (stream=lifecycle，不该被识别为工具)

console.log('\n[group 4] 真实观察到的事件 回归');

check('真实 agent/lifecycle → null', agentEventToTool({
  runId: '6034d7a7-37fc-45ce-adf3-f8bf038446ad',
  stream: 'lifecycle',
  data: { phase: 'start', startedAt: 1776873605498 },
  sessionKey: 'agent:main:cron:78293262-19b7-4b7d-bef0-5b799ecf5a84',
  seq: 1,
  ts: 1776873605498,
}) === null);

check('真实 session.message 用户 cron 启动 → 空 (纯 text)', (() => {
  const r = sessionMessageToTools({
    sessionKey: 'agent:main:cron:78293262-19b7-4b7d-bef0-5b799ecf5a84',
    message: {
      role: 'user',
      content: [{ type: 'text', text: '[cron] 执行一轮ETH交易决策' }],
    },
  });
  return r.entries.length === 0 && r.patches.length === 0;
})());

// ── group 5: sessionToolEventToAction — 真实 OpenClaw session.tool shape ──

console.log('\n[group 5] sessionToolEventToAction — 真实 shape');

// 真实观察到的 phase=update (in-flight)
// 注意：vancopper 日志里这种事件只有 phase/name/toolCallId，没有 meta。
// meta/title 要到 phase=result 或 agent/item 事件里才出现。
const REAL_UPDATE = {
  runId: '5f98f9a6-7f16-42f1-a99a-8c5d2428407d',
  stream: 'tool',
  sessionKey: 'agent:main:cron:78293262-19b7-4b7d-bef0-5b799ecf5a84',
  seq: 21,
  ts: 1776874520234,
  data: {
    phase: 'update',
    name: 'exec',
    toolCallId: 'call_1fab927ba0d84cdebb14ee7a',
    // 真实事件里没有 meta
  },
};

check('phase=update → kind=entry (input 空，等 result 来补)', (() => {
  const r = sessionToolEventToAction(REAL_UPDATE);
  return r && r.kind === 'entry'
      && r.entry.id === 'call_1fab927ba0d84cdebb14ee7a'
      && r.entry.tool === 'exec'
      && r.entry.input === ''
      && r.entry.status === 'ok'
      && r.entry.latency === 0
      && r.entry._startedAt === 1776874520234;
})());

check('phase=update 带 meta → input 取 meta', (() => {
  const r = sessionToolEventToAction({
    ...REAL_UPDATE,
    data: { ...REAL_UPDATE.data, meta: 'run python bot.py status' },
  });
  return r.entry.input === 'run python bot.py status';
})());

// 真实观察到的 phase=result (end)
const REAL_RESULT = {
  runId: '5f98f9a6-7f16-42f1-a99a-8c5d2428407d',
  stream: 'tool',
  sessionKey: 'agent:main:cron:78293262-19b7-4b7d-bef0-5b799ecf5a84',
  seq: 25,
  ts: 1776874520404,
  data: {
    phase: 'result',
    name: 'exec',
    toolCallId: 'call_1fab927ba0d84cdebb14ee7a',
    meta: 'run python ~/.openclaw/workspace/Trade/bot.py status',
    isError: false,
  },
};

check('phase=result isError=false → kind=patch status=ok', (() => {
  const r = sessionToolEventToAction(REAL_RESULT);
  return r && r.kind === 'patch'
      && r.patch.id === 'call_1fab927ba0d84cdebb14ee7a'
      && r.patch.status === 'ok'
      && r.patch._resultTs === 1776874520404;
})());

check('phase=result 携带 meta → patch.input 填入 (回填 update 留空的 input)', (() => {
  const r = sessionToolEventToAction(REAL_RESULT);
  return r && r.patch.input === 'run python ~/.openclaw/workspace/Trade/bot.py status'
      && r.patch.tool === 'exec';
})());

check('phase=result 无 meta → patch 不带 input', (() => {
  const r = sessionToolEventToAction({
    ...REAL_RESULT, data: { ...REAL_RESULT.data, meta: undefined },
  });
  return r && r.kind === 'patch' && !('input' in r.patch);
})());

check('phase=result isError=true → fail', (() => {
  const r = sessionToolEventToAction({
    ...REAL_RESULT, data: { ...REAL_RESULT.data, isError: true },
  });
  return r && r.patch.status === 'fail';
})());

check('无 toolCallId → null', sessionToolEventToAction({
  stream: 'tool', data: { phase: 'update', name: 'exec' },
}) === null);

check('data 缺 phase → 当作 entry 处理', (() => {
  const r = sessionToolEventToAction({
    stream: 'tool', ts: 1, data: { toolCallId: 'x', name: 'y' },
  });
  return r && r.kind === 'entry';
})());

check('input 过长被截断', (() => {
  const r = sessionToolEventToAction({
    stream: 'tool', ts: 1,
    data: { phase: 'update', name: 'x', toolCallId: 'x', meta: 'a'.repeat(100) },
  });
  return r.entry.input.length === 78 && r.entry.input.endsWith('…');
})());

// ── 汇总 ──

console.log(`\n结果：${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
