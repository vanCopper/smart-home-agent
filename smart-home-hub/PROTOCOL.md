# Smart Home Hub — WebSocket 协议

本文档定义前端 (`public/`) 与后端 (`server/`) 之间的 WebSocket 消息约定。所有消息都是 JSON 文本帧。

- 路径：`ws://<host>:3000/ws`
- 编码：UTF-8 JSON
- 心跳：客户端每 20–30s 可发 `{"type":"ping"}`，服务器回 `{"type":"pong"}`（可选）

---

## 1. 消息信封

```jsonc
// 客户端 → 服务器
{ "type": "subscribe",   "topics": ["env/indoor"] }
{ "type": "unsubscribe", "topics": ["env/indoor"] }
{ "type": "rpc",         "id": "r17", "method": "devices.toggle", "params": {"id":"ac_living"} }
{ "type": "ping" }

// 服务器 → 客户端
{ "type": "hello",       "server": "smart-home-hub/0.1.0", "ts": 172... }
{ "type": "event",       "topic": "env/indoor", "data": {...}, "ts": 172... }
{ "type": "rpc_result",  "id": "r17", "ok": true,  "data": {...} }
{ "type": "rpc_result",  "id": "r17", "ok": false, "error": "device not found" }
{ "type": "pong",        "ts": 172... }
```

**订阅即快照**：客户端发送 `subscribe` 后，服务端立即为每个 topic 推送一次当前最新值 (`event`)，之后按各自周期持续推送。

---

## 2. Topic 清单

所有 topic 字符串均在 `server/topics.js` 和 `public/js/core/topics.js` 集中定义，两边必须保持一致。

### 2.1 主屏 Hub

| Topic | 方向 | 频率 | 数据 |
|---|---|---|---|
| `clock/tick` | srv→cli | 1 s | `{ iso, hour, minute, second, weekday, date }` |
| `weather/current` | srv→cli | ~60 s | `{ temp, desc_zh, desc_en, low, high, city, uv, uv_label, wind_kmh, rain_pct, sunset }` |
| `env/indoor` | srv→cli | 5 s | `{ temp_c, humidity_pct }` |
| `env/outdoor` | srv→cli | 15 s | `{ temp_c, aqi, aqi_label }` |
| `devices/list` | srv→cli | on change + 快照 | `Device[]` |
| `devices/state` | srv→cli | on change | `{ id, state, status_text }` |
| `schedule/today` | srv→cli | on change | `ScheduleItem[]` |
| `schedule/tomorrow` | srv→cli | on change | `{ count, summary_zh, summary_en }` |
| `cameras/list` | srv→cli | on change | `Camera[]` |
| `scenes/list` | srv→cli | on change | `Scene[]` |
| `voice/state` | srv→cli | on change | `{ wake_word_zh, wake_word_en, gateway_ok, model, today_energy_kwh }` |
| `voice/event` | srv→cli | ad hoc | `{ type:"said"|"reply"|"end", text }` |

#### 数据结构

```ts
type DeviceState = 'on' | 'off' | 'warn';
interface Device {
  id: string;             // 'ac_living'
  name_zh: string;        // '客厅空调'
  name_en: string;        // 'Living AC'
  state: DeviceState;
  status_text: string;    // '制冷 26°C'
}

interface ScheduleItem {
  time: string;           // '16:00'
  title: string;          // '项目评审会'
  meta: string;           // '腾讯会议 · 45 min'
  who: 'me' | 'wife' | 'kid' | 'home';
  now?: boolean;
}

interface Camera {
  id: string;
  name_zh: string; name_en: string;
  stream_url: string | null;   // HLS/MP4 URL；为 null 时前端渲染占位
  live: boolean;
  placeholder?: string;        // 占位时显示的编号
}

interface Scene {
  id: string;              // 'away'
  name_zh: string; name_en: string;
  icon: string;            // 单个字符，例如 '☜'
  color: 'coral' | 'green' | 'blue' | 'amber';
  desc: string;            // '关灯 · 关空调 · 布防'
}
```

### 2.2 系统面板

| Topic | 方向 | 频率 | 数据 |
|---|---|---|---|
| `system/gateway` | srv→cli | 3 s | `{ running, ws, latency_ms, port, sessions, today_calls, mem_used_gb, mem_total_gb, cpu_pct, uptime_ms }` |
| `system/llm` | srv→cli | 5 s | `LLMStatus[]` |
| `system/nodes` | srv→cli | 8 s | `Node[]` |
| `system/tool-log` | srv→cli | on subscribe（快照） | `ToolCall[]` |
| `system/tool-log/append` | srv→cli | ad hoc | `ToolCall` 单条追加 |
| `system/energy` | srv→cli | 10 s | `{ today_kwh, cost_cny, hourly[24], month_kwh, vs_yesterday_pct }` |
| `system/summary` | srv→cli | 5 s | `{ gateway_ok, model_ok, nodes_on, nodes_off }` |

#### 数据结构

```ts
interface LLMStatus {
  name: string;           // 'FunctionGemma 270M'
  status: 'active' | 'standby' | 'offline';
  stats: Array<{ label: string; value: string }>;
}

interface Node {
  name: string;
  meta: string;
  online: boolean;
  ping_label: string;     // 'local' | '28ms' | 'offline'
  ping_class: '' | 'good';
}

type ToolCallStatus = 'ok' | 'fail' | 'skip';
interface ToolCall {
  id: string;             // 'log-<ts>-<rand>'
  time: string;           // '15:41:02'
  tool: string;           // 'air_conditioner'
  input: string;          // '"空调调到25度"'
  latency: number;        // ms
  status: ToolCallStatus;
}
```

---

## 3. 客户端 → 服务器 RPC

| Method | Params | 描述 | 副作用 |
|---|---|---|---|
| `devices.toggle` | `{ id }` | 切换设备开关 | 推 `devices/state` + `devices/list` |
| `scene.run` | `{ id, name_zh? }` | 执行场景 | 推两条 `voice/event`（用户说的 + Agent 回复） |
| `voice.greet` | *none* | 用户点击底部栏打招呼 | 推两条 `voice/event` |

后续扩展：`light.dim`, `ac.set_temp`, `scene.create`, `schedule.add`, `device.group_control` 等。

---

## 4. 前端使用

```js
import { wsClient } from '/js/core/ws-client.js';
import { TOPICS }   from '/js/core/topics.js';

// 订阅
const unsub = wsClient.subscribe(TOPICS.ENV_INDOOR, (data) => {
  console.log('室内:', data.temp_c, data.humidity_pct);
});

// RPC
const res = await wsClient.rpc('devices.toggle', { id: 'ac_living' });

// 取消订阅
unsub();
```

更常见的是通过 `store`：

```js
import { store } from '/js/core/store.js';
import { TOPICS } from '/js/core/topics.js';

store.bindTopic(TOPICS.ENV_INDOOR);         // 一次性绑定
store.subscribe(TOPICS.ENV_INDOOR, (data) => { ... });
// 或在 Web Component 中：
//   this.watch(TOPICS.ENV_INDOOR);
```

---

## 5. 对接真实数据源

当前 `server/mock/*.js` 是完全模拟的数据源。替换为真实数据时：

1. **OpenClaw Gateway / FunctionGemma**：在 `server/server.js` 建立到 Gateway 的连接（`ws://localhost:18789`），把 Gateway 事件映射到对应 topic。
2. **智能家居设备**：在 `RPC` handler 里调用实际的设备 Tool，保持返回格式不变。
3. **摄像头**：跑一个 RTSP→HLS 转码（ffmpeg），把输出的 `.m3u8` URL 填进 `cameras/list` 的 `stream_url`，前端的 `<video>` 自动播。
4. **能耗**：对接 HomeKit / 智能插座 API，把 24 小时分桶数据按原格式推到 `system/energy`。

前端和协议层都不用改。
