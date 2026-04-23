// server/tool-log-parse.js
// ────────────────────────────────────────────────────────────────
// 纯函数解析器：把 OpenClaw 的事件 payload 翻译成 tool-log entry。
//
// 拆出来独立成文件是为了能脱离 WS 连接直接跑 unit test（见同目录
// tool-log-parse.test.js）。openclaw-panels.js 里的 handler 只做
// "收事件 → 调这里 → publishToolLog" 三件事。
//
// 支持的事件形状（会持续扩充，每新增一种 shape 在 test 里加 fixture）：
//   1. session.tool 直接事件（老猜测 shape — 可能永远不会来）
//   2. agent 事件，stream 名里带 "tool"
//   3. agent 事件，data.tool / data.toolName / data.toolCallId / data.tool_use_id
//   4. session.message 的 content 里 type=tool_use 块
//   5. session.message 的 content 里 type=tool_result 块（→ 更新已有条目 status）
// ────────────────────────────────────────────────────────────────

export function fmtTime(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 真实 session.tool 事件形状（来自 vancopper 2026-04-22 日志）：
//   {
//     runId, stream:'tool', sessionKey, seq, ts,
//     data: { phase:'update'|'result', name:'exec', toolCallId, meta, isError? },
//     session: { ... 一堆元信息 ... }
//   }
// phase=update → 新 entry (status=ok, latency=0)；重复 update 忽略（或后续算部分进度）
// phase=result → patch 已有 entry：status 依 isError，latency 由 result.ts - update.ts
//
// 返回 { kind, entry|patch }，调用方用 ts 做 latency 推断。
export function sessionToolEventToAction(payload, now = new Date()) {
  if (!payload || typeof payload !== 'object') return null;
  const d = payload.data || {};
  const id = d.toolCallId || d.tool_use_id || d.id || null;
  if (!id) return null;

  const phase   = d.phase || 'update';
  const tool    = d.name || d.toolName || 'tool';
  const meta    = typeof d.meta === 'string' ? d.meta : '';
  const isError = d.isError === true || d.error != null;
  const ts      = Number(payload.ts) || 0;

  // 真实观察：phase=update 一般不带 meta，phase=result 才带 meta。
  // 所以 result 的 patch 必须把 input/tool 一起带上，覆盖 update 时留下的空 input。
  let input = meta;
  if (input.length > 80) input = input.slice(0, 77) + '…';

  if (phase === 'result' || phase === 'end' || phase === 'done') {
    const patch = {
      id: String(id),
      status: isError ? 'fail' : 'ok',
      // latency 留给调用方用 ts 差计算；payload 本身一般不带 duration
      _resultTs: ts,
    };
    if (input) patch.input = input;
    if (tool && tool !== 'tool') patch.tool = String(tool);
    return { kind: 'patch', patch };
  }

  // phase === 'update' / 'start' / 其它：当作新 entry
  return {
    kind: 'entry',
    entry: {
      id: String(id),
      time: fmtTime(ts ? new Date(ts) : now),
      tool: String(tool),
      input,
      latency: 0,
      status: 'ok',
      _startedAt: ts,       // 内部字段，用于 result 来时算 latency
    },
  };
}

// 兜底解析器：从一个扁平 payload 里尽可能拎出 { id, tool, input, latency, status }
// 返回 null 表示 "确认不是工具调用"。
export function payloadToToolEntry(p, now = new Date()) {
  if (!p || typeof p !== 'object') return null;

  const tool = p.tool?.name || p.toolName || p.tool_name
            || (typeof p.tool === 'string' ? p.tool : null)
            || p.name || null;
  if (!tool) return null;     // 没工具名就不当工具事件

  let input = '';
  const rawInput = p.args ?? p.arguments ?? p.input ?? p.params;
  if (typeof rawInput === 'string') input = rawInput;
  else if (rawInput != null)        input = JSON.stringify(rawInput);
  else if (p.prompt)                input = String(p.prompt);
  if (input.length > 80) input = input.slice(0, 77) + '…';

  const latency = Number(p.durationMs ?? p.latencyMs ?? p.elapsedMs ?? p.latency ?? 0) || 0;

  let status = 'ok';
  if (p.status === 'fail' || p.error || p.failed || p.result?.error) status = 'fail';
  else if (p.status === 'skip' || p.skipped || p.status === 'route') status = 'skip';
  else if (p.status && ['ok','fail','skip'].includes(p.status)) status = p.status;

  const id = p.id || p.toolCallId || p.tool_use_id || p.toolUseId
          || `tool-${now.getTime()}-${Math.random().toString(36).slice(2,7)}`;

  return { id: String(id), time: fmtTime(now), tool: String(tool), input, latency, status };
}

// agent 事件 → { kind: 'entry', entry } | { kind: 'patch', patch } | null
// agent 事件我们看到过 { stream, data, sessionKey, seq, ts, runId }
// result / done / end / error 类 stream 往往只带 id + durationMs（无 toolName），
// 作为 patch 返回；其它带 tool 信息的作为新 entry。
export function agentEventToTool(payload, now = new Date()) {
  if (!payload || typeof payload !== 'object') return null;
  const stream = String(payload.stream || '');
  const data   = payload.data || {};
  const s      = stream.toLowerCase();

  const isResultish = s.includes('result') || s.includes('done')
                   || s.includes('end')    || s.includes('error') || s.includes('fail');

  const id = data.toolCallId || data.tool_use_id || data.id || null;

  // result-ish 且有 id → patch（不强求 tool 名）
  if (isResultish && id) {
    const isErr = data.error != null || s.includes('error') || s.includes('fail') || data.status === 'fail';
    return {
      kind:  'patch',
      patch: {
        id:      String(id),
        status:  isErr ? 'fail' : (data.status || 'ok'),
        latency: Number(data.durationMs ?? data.latencyMs ?? data.elapsedMs ?? 0) || 0,
      },
    };
  }

  // 其余情况当新 entry —— 需要能解出 tool 名
  const entry = payloadToToolEntry({ ...data, id: id || payload.runId }, now);
  if (!entry) return null;

  // stream 额外修饰 status
  if (!data.status) {
    if (s.includes('error') || s.includes('fail')) entry.status = 'fail';
  }
  return { kind: 'entry', entry };
}

// session.message → 0..n 条 entry。
// content[].type === 'tool_use'     → 新建 entry (status: ok, latency: 0)
// content[].type === 'tool_result'  → 返回一条 partial patch，调用方用它来 update 已有条目
export function sessionMessageToTools(payload, now = new Date()) {
  const result = { entries: [], patches: [] };
  const msg = payload?.message || payload;
  if (!msg || typeof msg !== 'object') return result;

  const content = Array.isArray(msg.content) ? msg.content : [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;

    if (c.type === 'tool_use' || c.type === 'tool-call') {
      const entry = payloadToToolEntry({
        id:   c.id || c.toolUseId || c.tool_use_id,
        tool: c.name || c.tool?.name,
        args: c.input ?? c.arguments,
        status: 'ok',
      }, now);
      if (entry) result.entries.push(entry);
    }
    else if (c.type === 'tool_result' || c.type === 'tool-result') {
      const isErr = c.is_error === true || c.isError === true || c.error != null;
      // result patch: 匹配 id 后，更新 latency/status
      result.patches.push({
        id:      String(c.tool_use_id || c.toolUseId || c.id || ''),
        status:  isErr ? 'fail' : 'ok',
        latency: Number(c.durationMs ?? c.latencyMs ?? 0) || 0,
      });
    }
  }

  // role=tool 的消息：整条就是一个工具返回（不带 input，只是结束信号）
  if ((msg.role === 'tool' || msg.role === 'tool_result') && result.patches.length === 0) {
    const id = String(msg.tool_call_id || msg.toolCallId || msg.id || '');
    if (id) {
      result.patches.push({
        id,
        status:  msg.error ? 'fail' : 'ok',
        latency: Number(msg.durationMs ?? msg.latencyMs ?? 0) || 0,
      });
    }
  }

  return result;
}
