# Smart Home Agent 项目总结

> 最后更新：2026-04-25

---

## 一、项目概述

基于 **OpenClaw + Mac mini** 构建家庭智能 Agent 系统，具备语音交互、多设备控制、多成员协调、长期学习能力，以 iPad 壁挂屏作为家庭信息中心。

**硬件配置**

| 设备 | 用途 |
|------|------|
| Mac mini (Apple Silicon) | 主算力，24/7 运行所有服务 |
| iPad 10.9"（壁挂） | 中枢显示屏，Safari 全屏 Web App |
| USB 麦克风 | 拾音，通过 Mac mini 处理 |

---

## 二、整体架构

```
┌──────────────────────────────────────────────────────┐
│                     Mac mini                          │
│                                                      │
│  ┌─────────────────┐    ┌──────────────────────────┐ │
│  │  voice-agent    │    │     smart-home-hub        │ │
│  │  (Python)       │    │     (Node.js)             │ │
│  │                 │    │                           │ │
│  │  麦克风 → VAD   │    │  Express HTTP :3300       │ │
│  │  → ASR          │───▶│  WebSocket /ws            │ │
│  │  → LLM stream   │    │  /internal/voice/*        │ │
│  │  → TTS          │    │                           │ │
│  │  → 音频播放      │    │  openclaw.js              │ │
│  └─────────────────┘    │  → OpenClaw Gateway       │ │
│                         │    WS :18789              │ │
│                         └──────────────────────────┘ │
│                                  │                    │
│                         ┌────────▼───────────┐        │
│                         │  OpenClaw Gateway  │        │
│                         │  LLM / Tool Call   │        │
│                         │  Session / Memory  │        │
│                         └────────────────────┘        │
└───────────────────────────────────┬──────────────────┘
                                    │ LAN
                        ┌───────────▼──────────┐
                        │  iPad Safari          │
                        │  http://mac-mini.local│
                        │  :3300                │
                        └───────────────────────┘
```

---

## 三、Hub 中枢屏（smart-home-hub）

### 技术栈

- **运行时**：Node.js 18+，ES Modules
- **HTTP**：Express 4，静态服务 `/public`
- **实时推送**：WebSocket (`ws`)，Topic 订阅模式
- **启动**：`npm start`（读取 `.env`）

### 目录结构

```
smart-home-hub/
├── server/
│   ├── server.js           # 主入口，HTTP + WS + RPC handlers
│   ├── openclaw.js         # OpenClaw Gateway WS v3 长连客户端
│   ├── openclaw-panels.js  # Gateway 数据聚合（LLM/Tool/Voice/Nodes 面板）
│   └── topics.js           # Topic 常量定义
├── public/
│   └── js/                 # 前端组件（Web Components 风格）
└── .env                    # 环境变量（不入库）
```

### OpenClaw Gateway 接入（openclaw.js）

**认证方案：Ed25519 v3 签名 + V4 双写 token**

```
签名 payload = "v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|TOKEN|nonce|platform|deviceFamily"
connect params 需同时包含：
  - device.signature（Ed25519 签名）
  - auth.token（顶层，V4 格式要求）
```

**关键配置**

```
OPENCLAW_WS=ws://127.0.0.1:18789
OPENCLAW_TOKEN=<token>          # 放在 .env，npm start 自动读取
SCOPES=['operator.read', 'operator.write']  # write 是 sessions.send 必须的
```

**身份文件**：`~/.openclaw/smart-home-hub/identity.json`（首次启动自动生成 Ed25519 keypair）

### Voice API（server.js）

```
POST /internal/voice/event   { type, text }   → 向 iPad 推送语音状态
POST /internal/voice/send    { text, sessionKey }  → SSE 流式转发 LLM 回复
```

`/internal/voice/send` 流程：
1. `subscribeSession(sessionKey)` 确保订阅 Gateway 事件
2. `sessions.send` 向 LLM 发消息
3. 监听 `agent` 事件中的 `assistant.delta`，逐 token 以 SSE 推给 voice-agent
4. 监听 `lifecycle.end` 关闭流

---

## 四、语音管道（voice-agent）

### 完整流程

```
麦克风
  │
  ▼
wake_word.py  ── silero-vad（32ms/chunk）持续监听
  │               VAD burst 结束 → SenseVoice 转录 → 匹配唤醒词
  │ 匹配成功
  ▼
recorder.py   ── silero-vad 检测说话结束（VAD_SILENCE_SEC=0.8s）
  │               最长录 MAX_RECORD_SEC=12s
  ▼
asr.py        ── FunASR SenseVoiceSmall 转录
  │               送入前先归一化响度到 RMS=0.05
  ▼
main.py       ── 能量门控 + 幻听过滤
  │
  ▼
hub_client.py ── POST /internal/voice/send（SSE）
  │
  ▼
LLM 流式回复  ── SentenceChunker 按句切分
  │
  ▼
tts.py        ── F5-TTS MLX 合成（f5-tts-mlx）
  │               流水线：句 N+1 合成与句 N 播放并行
  ▼
player.py     ── sounddevice 播放
```

### 模块说明

#### wake_word.py — 唤醒词检测

**架构**：silero-vad 持续采集 → burst 结束后 SenseVoice 转录 → 三层匹配

**三层匹配**（精确到模糊）：
1. 精确字符子串：`'小新' in transcript`
2. 拼音全串：`'xiaoxin' in pinyin(transcript)`（覆盖同音异字）
3. 音节子序列：`['xiao','xin'] ⊆ syllables(transcript)`（覆盖多余词/部分识别）

**关键参数**（wake_word.py 顶部）：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| MIN_SPEECH_MS | 600ms | burst 总时长下限（含尾部静音）|
| MIN_VOICED_MS | 320ms | burst 内实际语音帧下限（防咳嗽/笑声）|
| SILENCE_END_MS | 400ms | 静音多久判定 burst 结束 |
| cooldown_sec | 3.0s | 上一轮结束后屏蔽时间（防 TTS 尾音触发）|

**重要 bug 历史**：
- ❌ 不能把唤醒词放进 `initial_prompt` → Whisper 会在任意噪声上"续写"输出唤醒词，每次咳嗽必触发
- ✅ 送 ASR 前要归一化响度，否则 SenseVoice 在低音量(rms<0.01)上乱输出

#### recorder.py — 录音与 VAD

**关键逻辑**：
- `START_DEBOUNCE = 5`：需要连续 5 帧（160ms）VAD 为正才确认开始说话
- 确认前还要检查 pre-buffer 的 RMS ≥ 0.004（防风扇噪声触发 debounce）
- `pre_buffer` 保留 debounce 前的帧，避免裁掉首音节
- `initial_timeout_sec`：follow-up 模式下，若该时间内无人开口则超时返回

#### asr.py — 语音识别

**主 ASR**：`FunASR SenseVoiceSmall`（`iic/SenseVoiceSmall`）
- 专为中文训练，大幅优于 Whisper 的中文识别率
- 送入前归一化到 TARGET_RMS=0.05
- 输出需要去掉 SenseVoice 的标签：`<|zh|><|NEUTRAL|><|Speech|>...`

**唤醒词 ASR**：同样使用 SenseVoiceSmall（不再使用 whisper-small）

**配置**（`.env`）：
```
ASR_MODEL=iic/SenseVoiceSmall
WAKE_WHISPER_MODEL=mlx-community/whisper-small-mlx  # 保留但不再用于唤醒词
```

#### tts.py — 语音合成（F5-TTS + 音色克隆）

**模型**：`lucasnewman/f5-tts-mlx`（MLX 量化版，Apple Silicon GPU）

**速度优化**：
- 默认 `steps=8, method='euler'`（原为 32 步，4× 提速）
- 短文本（≤3字）自动升为 `steps=16, method='rk4'`（防止"我在"等短句质量差）
- 专用单线程 `ThreadPoolExecutor`（模型在 executor 内加载，解决 MLX Stream 线程问题）

**兼容性补丁**：
- `_patch_mlx_sdpa()`：mlx 0.31+ 的 SDPA `scale` 参数要求 float，旧版 f5-tts-mlx 传 `mx.array`，需 monkey-patch 强制转型

**音色克隆**：
```
REF_VOICE_PATH=ref_voices/shincha_5s.wav
REF_VOICE_TEXT=大家好，我是Parrot，虚拟老师。我们来读一首诗。
```

**性能参考**（Mac mini M 系列）：
```
[tts] 8.34s audio in 4.39s  RTF=0.53   (短句，单段)
[tts] 7.81s audio in 4.04s  RTF=0.52   (短句，单段)
```

#### main.py — 主流程

**每轮对话流程**：
1. `hub.voice_event('listening')` → 屏幕显示"聆听中"
2. `recorder.record_until_silence()` → 录音
3. 能量门控：`dur < 0.5s` 或 `rms < 0.005` → 丢弃
4. 幻听过滤：正则匹配 YouTube 常见幻听词（"请不吝点赞订阅"等）
5. 归一化 → SenseVoice 识别
6. `hub.voice_event('said', text)` → 屏幕显示识别结果
7. 播放发送音效（双音提示音）
8. SSE 流式拉取 LLM 回复
9. SentenceChunker 切句 → 流水线 TTS + 播放

**连续对话**：LLM 回复后保持聆听状态 `FOLLOWUP_SEC=5s`，超时无人说话则回到唤醒词等待。

**关键环境变量**（voice-agent/.env）：

```bash
HUB_URL=http://127.0.0.1:3300
OPENCLAW_SESSION=agent:main:main     # LLM 对话 session key
WAKE_WORDS=蜡笔小新,小新
ASR_MODEL=iic/SenseVoiceSmall
WAKE_WHISPER_MODEL=mlx-community/whisper-small-mlx
TTS_MODEL=lucasnewman/f5-tts-mlx
REF_VOICE_PATH=ref_voices/shincha_5s.wav
REF_VOICE_TEXT=大家好，我是Parrot，虚拟老师。我们来读一首诗。
MIC_DEVICE_INDEX=0
VAD_SILENCE_SEC=0.8
MAX_RECORD_SEC=12
FOLLOWUP_SEC=5
```

---

## 五、启动方式

```bash
# Hub（Node.js）
cd smart-home-hub
npm start                  # 读取 .env，监听 :3300

# Voice Agent（Python）
cd voice-agent
source .venv/bin/activate
python main.py
```

**首次安装**：
```bash
# voice-agent
pip install funasr mlx-whisper sounddevice torch f5-tts-mlx httpx python-dotenv pypinyin soundfile
```

---

## 六、已知问题 & 待优化

### 语音唤醒

| 问题 | 状态 | 建议方案 |
|------|------|---------|
| "小新"（2音节）识别不稳 | 部分解决（三层拼音匹配） | 考虑改用专用唤醒词模型（sherpa-onnx）|
| 咳嗽/笑声偶发误触发 | 已缓解（voiced帧计数+RMS门控）| 继续观察，按需调整 MIN_VOICED_MS |

### ASR

| 问题 | 状态 | 备注 |
|------|------|------|
| SenseVoice 短音频低音量乱输出 | 已修（归一化到 RMS=0.05）| |
| 偶发同音字错误 | 可接受 | SenseVoice 已比 Whisper 好很多 |

### TTS

| 问题 | 状态 | 备注 |
|------|------|------|
| RTF 约 0.5（2s 延迟/4s 音频）| 当前水平 | 可调低 steps 换质量 |
| 首句延迟（LLM → TTS 启动）| 已通过流水线缓解 | |

### Hub / LLM

| 问题 | 状态 | 备注 |
|------|------|------|
| 语音对话与日常聊天历史混用 | 未解决 | 需在 OpenClaw 中手动创建独立 session（agent:voice:main 等）|
| OpenClaw `sessions.create` 无效 | 确认 | 新 session 只能通过 App UI 创建 |

---

## 七、系统架构演进计划

### P0 — 核心链路完善

1. **家电 Skill 封装**：把电器/电视接口包装成 OpenClaw Tool，定义 schema
2. **独立语音 Session**：在 OpenClaw App 里创建专用 session，避免与日常聊天混用
3. **唤醒词优化**：评估 sherpa-onnx 离线唤醒词方案，彻底解决误触发

### P1 — 体验增强

4. **多成员协调**：声纹识别 / 人脸识别 → 个性化响应
5. **场景引擎**：时间/传感器触发的自动化规则
6. **摄像头流**：RTSP → HLS 接入中枢屏

### P2 — 长期能力

7. **本地快通道**：FunctionGemma 270M 微调，实现 < 500ms 家电控制
8. **行为学习**：隐式行为统计 + 偏好推断 + 定期写回 OpenClaw Persona
9. **iOS 联动**：地理围栏 + 手机状态感知

---

## 八、UI 中枢屏

### 主屏幕（hub-page）

四栏布局：

| 区域 | 模块 | 内容 |
|------|------|------|
| 左侧 | 时钟 + 天气 | 大字时钟、天气详情（UV/风速/降雨/日落）|
| 中上 | 环境 + 设备 | 室内温湿度、AQI；6个设备卡片可触控 |
| 右侧 | 家庭日程 | 多成员日程，明日预告 |
| 中下 | 摄像头 + 场景 | 实时画面 + 一键场景快捷 |
| 底部 | 语音状态栏 | 唤醒/聆听/识别/回复 状态，Gateway 连接指示 |

### 系统面板（system-page）

从主屏底部进入：Gateway 状态、LLM 模型、Tool Call 日志、节点列表、能耗统计。

---

## 九、关键技术决策记录

| 决策 | 选择 | 原因 |
|------|------|------|
| 主 ASR | FunASR SenseVoiceSmall | 中文专项训练，大幅优于 Whisper |
| 唤醒词 ASR | 同 SenseVoice | whisper-small 中文短句不可靠 |
| TTS | F5-TTS MLX + 音色克隆 | 本地推理，保留用户自定义音色 |
| TTS 加速 | steps=8/euler | 原 32 步降至 8 步，RTF 从 2.0 降至 0.5 |
| MLX 线程 | 专用单线程 executor | MLX Stream 有线程局部性约束 |
| OpenClaw 认证 | V4（token 双写）| 经 8 种变体探测确认 |
| 唤醒词 prompt | 中性上下文，不含唤醒词 | 唤醒词入 prompt 会导致噪声必触发 |
| 响度归一化 | TARGET_RMS=0.05 | 麦克风原始 rms~0.008，不归一化模型乱输出 |

---

*Generated: 2026-04-25*
