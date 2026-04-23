# OpenClaw Gateway 集成笔记

记录 smart-home-hub ↔ OpenClaw Gateway 的对接方案、协议细节、踩过的坑。
开发接续时先读这篇。

当前状态（2026-04-22）：**6 个 system 面板里 5 个已接真实数据源，1 个（Energy）仍是 mock。**

---

## 1. 架构

```
┌──────────── Mac mini ────────────┐
│                                   │
│  OpenClaw Gateway                 │
│   ws://127.0.0.1:18789            │
│   (v3 protocol, Ed25519 device    │
│    identity auth)                 │
│        ▲                          │
│        │ WebSocket (长连)         │
│        │                          │
│  smart-home-hub (:3300)           │
│   ├─ server/openclaw.js           │ ← 签名握手 + 长连客户端
│   │    (start / rpc / on)         │
│   ├─ server/openclaw-panels.js    │ ← 面板数据聚合
│   │    (5 路 snapshot 函数)       │
│   └─ server/server.js             │ ← HTTP + WS to front-end
│        │                          │
└────────┼──────────────────────────┘
         │
         │ WebSocket /ws
         │ topic 订阅 (env/indoor, system/gateway, ...)
         ▼
   iPad Safari — 主屏 + #/system
```

**职责分层：**

- `openclaw.js` — 纯协议客户端。只做握手 / 重连 / `rpc()` / `on(event)`。不懂业务。
- `openclaw-panels.js` — 业务聚合。懂"LLM 面板需要什么"、"Tool Log 需要什么"。所有字段映射 / 解析容错都在这里。
- `server.js` / `standalone.js` — 把 panels 的 snapshot 函数接到 topic 上 publish。不涉及 OpenClaw 协议。

想加新面板：改 `openclaw-panels.js` 写新 snapshot → 在 `server.js` 的 SNAPSHOTS/ticker 里注册一行。无需动 `openclaw.js`。

---

## 2. 握手：v3 Ed25519 签名

**身份文件路径**：`~/.openclaw/smart-home-hub/identity.json`

```json
{
  "deviceId": "fb7efe088e0ec2cc1ced73f981d837180bc03c003599ff9f431bd02e1753ed44",
  "publicKeyB64": "zZrq2JHIvVAmz3S22jcQ24U6dxPVjqKxm5g2OIUZT6Q=",
  "privateKeyPem": "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n",
  "createdAt": "2026-04-22T07:25:38.083Z"
}
```

- `deviceId` = `sha256(raw-pubkey-32-bytes)` 的小写 hex
- `publicKeyB64` = raw 32 字节 Ed25519 公钥的 base64
- 第一次启动自动生成，之后复用；删掉就重新生成（也就是换身份）

**v3 签名 payload**（从 OpenClaw 源码 `src/gateway/device-auth.ts` 抠出）：

```
v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily
```

我们的固定取值：

| 段 | 值 |
|----|----|
| clientId | `cli` |
| clientMode | `cli` |
| role | `operator` |
| scopes | `operator.read`（逗号分隔；目前只需 read） |
| token | 空串（`auth.mode: "none"` 场景下 gateway 也用空串） |
| platform | `macos` / `linux` / `windows`（`process.platform` 映射） |
| deviceFamily | `desktop` |

`signedAtMs` 是 `Date.now()`，`nonce` 从服务器的 `connect.challenge` 事件里拿。签名用 Node 的 `crypto.sign(null, buf, privateKey)`，base64 编码。

**握手流程：**

```
client → ws://127.0.0.1:18789
server ← event connect.challenge { nonce, ts }
client → req connect { client:{…}, role, scopes, device:{id, publicKey, signature, signedAt, nonce} }
server ← res ok hello-ok { protocol:3, features:{methods,events}, snapshot, auth:{deviceToken} }
```

拿到 `hello-ok` 就认为 session 建立，之后用 `rpc()` 调方法、`on()` 订事件。重连时重跑同一套握手。

---

## 3. 关键 Gateway 配置

用户侧 OpenClaw `config.json` 必须有：

```json
"gateway": {
  "bind": "loopback",
  "port": 18789,
  "controlUi": {
    "allowInsecureAuth": true,
    "dangerouslyDisableDeviceAuth": true
  },
  "auth": { "mode": "none" }
}
```

**为什么这两个 flag 必须开：**

- `auth.mode: "none"` 只关了 shared-secret 层（token/password），device 身份层还会要求配对
- `controlUi.dangerouslyDisableDeviceAuth: true` 在 loopback 下跳过"deviceId 必须在白名单里"这道闸；没有它，第一次连会返回 `NOT_PAIRED`

外部客户端（非 Control UI SPA）理论上该走正式的 `device.pair.*` 配对流程。我们这个 hub 跑在 gateway 同机 loopback，直接复用 Control UI 的 bypass 更简单。将来 hub 迁到别的机器需要重新考虑这个。

---

## 4. 协议：RPC / 事件

### 公开的 methods（从 `hello-ok.features.methods` 里挑了我们关心的）

| Method | 用途 | 我们用到？ |
|--------|------|-----------|
| `status` | 刷新 snapshot（presence / health / sessions） | ✓ 每 5s 刷 Gateway 卡片 |
| `models.list` | 可用模型列表 | ✓ LLM 面板 |
| `usage.status` | 用量统计（per-provider） | ✓ LLM 面板（目前 windows 空） |
| `usage.cost` | 成本统计 | 留后 |
| `voicewake.get` | 唤醒词 | ✓ Voice Bar |
| `talk.config` | TTS / 语音配置 | ✓ Voice state 扩展字段 |
| `talk.mode` | 切换语音模式 | ✗ setter，要 `operator.write` |
| `sessions.list` | 会话列表 | 留后 |
| `sessions.messages.subscribe` | 订阅某会话的消息/工具调用 | 留后（目前靠全局 `session.tool` 事件） |
| `agents.list` | agent 列表 | 留后 |
| `channels.status` | 接入渠道状态（Feishu 等） | 留后 |

**scope 约束：** 我们请 `scopes: ['operator.read']`。任何 setter（`talk.mode`、`config.set`、`sessions.send`、`devices.toggle` 等）都会返回 `INVALID_REQUEST: missing scope: operator.write`。要调用时把 `SCOPES` 加上 `'operator.write'`，重签；gateway 会重下发 deviceToken。

### 已观察到的真实返回 shape（2026-04-22）

```js
// models.list
{
  models: [
    { id:"glm-4.7",     name:"GLM-4.7",     provider:"zai", contextWindow:204800, reasoning:true, input:["text"] },
    { id:"glm-5",       name:"GLM-5",       provider:"zai", contextWindow:202800, reasoning:true, input:["text"], alias:"GLM" },
    { id:"glm-5-turbo", name:"GLM-5 Turbo", provider:"zai", contextWindow:202800, reasoning:true, input:["text"] },
    { id:"glm-5.1",     name:"GLM-5.1",     provider:"zai", … }
  ]
}
// 约定：有 alias 的是默认/active 模型
```

```js
// usage.status
{
  updatedAt: 1776848694767,
  providers: [
    { provider:"zai", displayName:"z.ai", windows: [] }   // 目前 windows 为空
  ]
}
// windows 的内部 shape 还没见过，按 {calls, avgLatencyMs, startMs, endMs} 估着写的
```

```js
// voicewake.get
{ triggers: ["蜡笔小新", "computer"] }
```

```js
// talk.config
{
  config: {
    talk: {
      interruptOnSpeech: true,
      silenceTimeoutMs: 1500,
      provider: "elevenlabs",
      providers: {
        elevenlabs: { apiKey:"__REDACTED__", baseUrl, voiceId:"tongtong", modelId:"eleven_v3", outputFormat:"pcm_44100" }
      },
      resolved: { provider:"elevenlabs", config: { voiceId, modelId, baseUrl, … } }
    }
  }
}
```

```js
// hello-ok.snapshot（精简，完整见 openclaw-ws-signed.js 跑一次的输出）
{
  presence: [
    { host, ip, version, platform, deviceFamily, mode:"gateway"|"local", ts, lastInputSeconds? }
  ],
  health: {
    sessions: { path, count:620, recent:[…] },
    agents: [ { agentId:"main", isDefault:true, heartbeat, sessions } ],
    channels: { feishu: {…} }
  },
  uptimeMs: 11168539,
  sessionDefaults: { defaultAgentId:"main", … },
  updateAvailable: { currentVersion:"2026.4.11", latestVersion:"2026.4.15", channel:"latest" }
}
```

### 事件（`hello-ok.features.events`）

| Event | 触发 | 我们用到？ |
|-------|------|----------|
| `connect.challenge` | 握手阶段下发 nonce | ✓ 握手 |
| `session.tool` | 某 agent 调用工具 | ✓ Tool Log（shape 未观察到，解析器容错） |
| `session.message` | 消息产生 | 留后 |
| `sessions.changed` | 会话列表变动 | 留后 |
| `presence` | 节点心跳 | 可用于 Nodes 面板实时刷新 |
| `tick` | 定时心跳 | 没用（我们靠 `status` RPC 刷） |
| `talk.mode` | 语音模式切换 | 留后 |
| `health` | 健康状态 | 留后 |
| `voicewake.changed` | 唤醒词改动 | 可订阅以免 5s 轮询延迟 |
| `device.pair.requested/resolved` | 配对流程 | 非 loopback 部署时要用 |

---

## 5. 文件清单

```
server/
├── openclaw.js                  # 长连客户端：身份 / 握手 / rpc / on / 重连
├── openclaw-panels.js           # 5 路面板聚合 + tool log 环形缓冲
├── openclaw-ws-signed.js        # 单次握手探测 (debug)
├── openclaw-rpc-probe.js        # 批量调 RPC 打印 shape (debug)
├── openclaw-ws-handshake.js     # 5 种 Control UI 伪装策略探测 (历史，保留作记录)
├── openclaw-bundle-scan.js      # 从 SPA bundle 反查 API 端点 (历史)
├── openclaw-http-probe.js       # HTTP 端点探测 (历史)
├── openclaw-probe.js            # 第一版 device 身份探测 (历史)
├── server.js                    # Express 版 hub 服务
├── standalone.js                # 零依赖版 hub 服务
├── topics.js
└── mock/
    ├── hub.js                   # 主屏 mock（保留）
    └── system.js                # 系统面板 mock（仅 energySnapshot 仍在用）
```

## 6. 调试脚本

**握手探测**（看 v3 签名是否通过）：
```bash
node server/openclaw-ws-signed.js
```
预期输出 `✓ CONNECT OK` + 完整 hello-ok payload。失败会打印 error code（常见：`NOT_PAIRED` / `INVALID_SIGNATURE` / `INVALID_REQUEST`）。

**RPC shape 探测**（看各方法返回什么）：
```bash
node server/openclaw-rpc-probe.js
```
逐个调 13 个只读 RPC（models.list / usage.status / voicewake.get / talk.config / sessions.list / status / agents.list / gateway.identity.get / channels.status / tools.catalog / tools.effective / usage.cost / talk.mode），失败打 error。

**运行 hub**：
```bash
node server/server.js      # Express 版（推荐）
node server/standalone.js  # 零依赖版
```

启动时 stdout 应该看到：
```
[openclaw] identity: <64-hex>
[openclaw] connecting ws://127.0.0.1:18789
[openclaw] ✓ connected  v3  connId=…  (Nms)
[openclaw-panels] started
[openclaw-panels] ▲ models.list → {…}
[openclaw-panels] ▲ usage.status → {…}
[openclaw-panels] ▲ voicewake.get → {…}
[openclaw-panels] ▲ talk.config → {…}
```

---

## 7. Topic ↔ 数据源映射

| 前端 topic | 数据源 | 负责函数 | 状态 |
|-----------|--------|---------|------|
| `system/gateway` | hello-ok snapshot + `status` RPC（每 5s） | `openclaw.gatewaySnapshot` | ✓ 真实 |
| `system/llm` | `models.list` + `usage.status` | `claw.llmStatusSnapshot` | ✓ 真实 |
| `system/nodes` | hello-ok snapshot.presence | `claw.nodesSnapshot` | ✓ 真实 |
| `system/tool-log` | `session.tool` 事件环形缓冲 | `claw.toolLogSnapshot` | ✓ 真实（等实际调用填充） |
| `system/tool-log/append` | `session.tool` 事件 → onToolLogAppend | `claw.onToolLogAppend` | ✓ 真实 |
| `voice/state` | `voicewake.get` + `talk.config` + `models.list` | `claw.voiceStateSnapshot` | ✓ 真实 |
| `system/summary` | 以上聚合 | `claw.sysSummarySnapshot` | ✓ 真实 |
| `system/energy` | 仍 mock | `sys.energySnapshot` | ✗ 待接电表 |
| `clock/tick` / `weather/*` / `env/*` / `devices/*` / `cameras/*` / `scenes/*` / `schedule/*` | mock | `hub.*` | ✗ 独立任务 |

---

## 8. 已知待办

按优先级：

1. **`usage.status.providers[].windows` shape**。目前 OpenClaw 没有累计调用 → windows 一直空。等用户手动和 agent 多聊几轮后，调 `openclaw-rpc-probe.js` 看 windows 元素的字段。确认后把 `openclaw-panels.js` 里 `usageByProvider()` 的 `w.calls / w.avgLatencyMs` 字段名收紧。
2. **`session.tool` 事件 shape**。目前 `toToolLogEntry` 用多字段 fallback 写死。待 agent 真的调用工具后，日志会打印 `▲ event session.tool → {…}`。看一眼然后收紧字段名。
3. **Energy 数据源**。可选方案：
   - (a) HomeAssistant WebSocket API，订阅智能插座的功率 topic
   - (b) 小米电表 / 米家 API
   - (c) 买个带 MQTT 的独立电表
4. **Gateway CPU / 内存 / today_calls**。hello-ok snapshot 里没有这三项。可能来源：
   - `presence[i].modelIdentifier` 已经有硬件型号，但没动态 CPU/mem
   - OpenClaw 可能有未公开的 `system.metrics` 之类 RPC，下次 probe 时试 `systemMetrics / host.stats / gateway.stats / metrics.get`
5. **presence 事件订阅**。目前靠 5s 的 `status` RPC 刷 snapshot.presence。改成订阅 `presence` 事件可以做到节点上下线秒级响应。
6. **operator.write scope 准备**。等要加"从 iPad 发指令"的场景（开灯 / 触发场景），要在 `openclaw.js` 的 `SCOPES` 里加 `'operator.write'`，重新握手。deviceToken 会重发。
7. **非 loopback 部署**。hub 如果以后要搬到别的机器连远程 gateway，`controlUi.dangerouslyDisableDeviceAuth` bypass 不适用，需要走 `device.pair.request` / `device.pair.approve` 的正式配对。

---

## 9. 故障排查 checklist

**前端 Gateway 卡片显示 Offline：**
1. `curl http://127.0.0.1:18789/health` → 看 gateway 本身是否在跑
2. hub stdout 有没有 `[openclaw] ✓ connected`？没有的话看 `[openclaw] ws error: …`
3. 常见错误 `NOT_PAIRED`：gateway config 里 `controlUi.dangerouslyDisableDeviceAuth` 没开
4. 常见错误 `INVALID_SIGNATURE`：identity.json 坏了，删掉重生即可
5. 常见错误 `INVALID_REQUEST: missing scope: operator.write`：调了 setter RPC 而 scopes 里没 write

**LLM 卡片显示 Loading…：**
- `models.list` 还没返回。等 5s 看是否刷新；不刷新就 probe 一下看是不是 RPC 超时

**Tool Log 空：**
- 预期行为。OpenClaw 里触发一次工具调用（比如跟 main agent 说"打开空调"）就有条目

**身份相关的"重置"**：`rm -rf ~/.openclaw/smart-home-hub` 再重启 hub，会生成新 deviceId（gateway 配了 bypass 的话直接放行，不需要重新配对）
