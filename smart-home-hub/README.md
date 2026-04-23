# Smart Home Hub Screen

家庭智能中枢屏 Web App，运行在 Mac mini 上，iPad 10.9" 挂墙通过 Safari 全屏访问。

```
smart-home-hub/
├── server/                    # Node.js + Express + ws 本地服务
│   ├── server.js              # 入口 (HTTP + WebSocket)
│   ├── standalone.js          # 零依赖版入口（不需要 npm install）
│   ├── topics.js              # Topic 常量（与前端共享）
│   ├── openclaw.js            # OpenClaw Gateway 长连客户端（v3 Ed25519 签名握手）
│   ├── openclaw-panels.js     # LLM / ToolLog / Voice / Nodes / Summary 面板聚合
│   ├── openclaw-ws-signed.js  # 单次握手探测 (debug)
│   ├── openclaw-rpc-probe.js  # 批量 RPC shape 探测 (debug)
│   └── mock/
│       ├── hub.js             # 主屏数据 mock
│       └── system.js          # 系统面板数据 mock（只剩 energySnapshot 仍在用）
├── public/                    # 前端（零构建，浏览器 ES modules 直开）
│   ├── index.html             # 入口
│   ├── styles/
│   │   ├── tokens.css         # 设计令牌 (light/dark)
│   │   ├── base.css           # reset + 通用
│   │   ├── hub.css            # 主屏样式
│   │   └── system.css         # 系统面板样式
│   └── js/
│       ├── main.js            # 应用启动
│       ├── core/              # 基础设施
│       │   ├── ws-client.js   # Topic 订阅 WebSocket 客户端
│       │   ├── store.js       # Reactive store
│       │   ├── router.js      # Hash router
│       │   ├── topics.js      # Topic 常量
│       │   └── base-component.js  # Web Component 基类
│       ├── components/        # 13 个 Web Components
│       └── pages/             # 两个页面组装器
├── PROTOCOL.md                # 前端 ↔ hub 的 WebSocket topic / RPC 协议
├── OPENCLAW_INTEGRATION.md    # hub ↔ OpenClaw Gateway 集成笔记（握手 / RPC shape / 故障排查）
├── package.json
└── README.md
```

## 运行

```bash
npm install
npm start           # 启动 http://localhost:3300 和 ws://localhost:3300/ws
# 或开发模式 (自动 reload server)
npm run dev
```

打开 `http://localhost:3300` 看到主屏。URL 加 `#/system` 进入系统面板；也可以点击主屏底部状态栏右侧的 "Gateway / FunctionGemma" 区域跳转。

## iPad 接入

- iPad 连同一 Wi-Fi，Safari 打开 `http://mac-mini.local:3300`
- 也可直接用内网 IP 访问：`http://<你的内网IP>:3300`
- Windows 查看内网 IP：`Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | Select-Object InterfaceAlias, @{N='IPv4';E={$_.IPv4Address.IPAddress}}`
- 优先使用有默认网关的网卡 IP（例如 `10.x.x.x` / `192.168.x.x`），不要用 `vEthernet` 等虚拟网卡地址（常见 `172.x.x.x`）
- 添加到主屏幕（分享 → 添加到主屏幕）：获得独立图标、无浏览器 UI
- 设置 → 辅助功能 → 引导式访问：打开后三击电源键锁定 Safari 全屏，禁止退出
- 关闭自动锁定（引导式访问内的选项）
- 保持 iPad 充电

## 页面路由

- `#/` 或 `#/hub` → 主屏
- `#/system` → 系统面板

两个页面始终挂在 DOM 里，router 只切换 `.active`。这样 WebSocket 订阅不会反复建立/断开，跨页切换无感。

## 组件

前端用原生 Web Components 组织，每个组件：

- 继承 `BaseComponent` (`/js/core/base-component.js`)
- `init()` 里订阅 store 里的 topic、绑定事件
- `render()` 返回 HTML 字符串，store 更新时自动重渲染
- 不使用 Shadow DOM，以便继承全局 CSS 变量和 light/dark 切换

```js
import { BaseComponent, esc } from '../core/base-component.js';
import { TOPICS } from '../core/topics.js';

class MyWidget extends BaseComponent {
  init()  { this.watch(TOPICS.ENV_INDOOR); }
  render(){
    const d = this.data(TOPICS.ENV_INDOOR) || {};
    return `<div class="c">室内 ${esc(d.temp_c)}°C</div>`;
  }
}
customElements.define('my-widget', MyWidget);
```

## 数据层

`public/js/core/ws-client.js` 是单例 WebSocket 客户端：

- 页面加载时连接 `/ws`
- 断线指数退避重连（1s → 10s）
- 多 handler 订阅同一 topic，只向服务器发送一次 subscribe
- 重连后自动重新订阅
- 提供 `rpc(method, params)` 调用服务端 action

`store.js` 是按 key（通常就是 topic）的发布订阅 store。每个 topic 在 `main.js` 里被 `bindTopic` 一次，之后多个组件可并行订阅同一 key。

WebSocket 协议细节见 [PROTOCOL.md](PROTOCOL.md)。

## 对接真实数据

1. **OpenClaw Gateway** — 已接。`server/openclaw.js` 做 Ed25519 v3 签名握手长连，`server/openclaw-panels.js` 把 RPC / 事件转成 5 个 system topic 的 snapshot。细节见 [OPENCLAW_INTEGRATION.md](OPENCLAW_INTEGRATION.md)。
2. **设备控制** — 在 `RPC` handlers 里调用实际的 Tool，保持返回格式不变。现在用 `openclaw.rpc('sessions.send', …)` 就能驱动真实 agent；需要在 `openclaw.js` 的 `SCOPES` 里加 `'operator.write'`。
3. **摄像头** — 跑 ffmpeg RTSP→HLS，把输出的 `.m3u8` URL 填进 `cameras/list` 的 `stream_url`。
4. **能耗** — 对接 HomeAssistant / 智能插座 API，按原格式推 `system/energy`。

前端代码和协议都不用改。

## 已打通 vs. 待做

- [x] 主屏 + 系统面板的完整 UI
- [x] 页面路由（hash 切换）
- [x] WebSocket + topic 订阅框架（重连 / RPC / 队列）
- [x] reactive store
- [x] 13 个 Web Components，全部接入 store
- [x] 完整 mock 数据和周期推送
- [x] 设备切换、场景触发、语音对话框等交互
- [x] OpenClaw Gateway 对接（v3 Ed25519 签名握手 + 长连 WS；详见 [OPENCLAW_INTEGRATION.md](OPENCLAW_INTEGRATION.md)）
  - [x] `system/gateway` — 运行状态 / 延迟 / 会话数 / uptime
  - [x] `system/llm` — 可用模型列表（含 active/standby 状态）
  - [x] `system/nodes` — 节点 presence
  - [x] `system/tool-log` — 实时工具调用日志
  - [x] `voice/state` — 唤醒词 / 默认模型 / TTS 配置
  - [x] `system/summary` — 底部状态聚合
- [ ] `system/energy` 真实数据源（智能插座 / 电表）
- [ ] `system/gateway` 补齐 CPU / 内存 / today_calls
- [ ] 真实天气 API（当前随时间正弦波动）
- [ ] 真实摄像头流（RTSP→HLS）
- [ ] 设备控制走 OpenClaw（需要加 `operator.write` scope）
- [ ] 多成员身份识别
```
