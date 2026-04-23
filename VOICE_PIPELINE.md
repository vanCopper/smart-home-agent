# 语音管道架构方案

## 概述

全链路运行在 Mac Mini（Apple Silicon）上，iPad 作为纯展示终端。

## 数据流

```
Mac Mini
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│  [voice-agent  Python 服务]      [smart-home-hub  Node.js]     │
│                                                                │
│  USB 麦克风                                                     │
│    ↓                                                           │
│  openwakeword                                                  │
│  检测到 "小管家" / "Hey Home"                                   │
│    ↓                              POST /internal/voice/event   │
│  silero-vad + sounddevice 录音 ──→ { type:'listening' } ──────→│──→ iPad
│    ↓                                                           │
│  mlx-whisper (Metal GPU ~1s)                                   │
│    ↓                              POST /internal/voice/event   │
│  转录完成 ─────────────────────→ { type:'said', text } ───────→│──→ iPad
│    ↓                                                           │
│  POST /internal/voice/send                                     │
│  SSE 流式接收 LLM 回复                                          │
│    ↓                                                           │
│  sentence_chunker                 POST /internal/voice/event   │
│  凑满一句 ─────────────────────→ { type:'reply', text } ──────→│──→ iPad 实时更新
│    ↓                                                           │
│  mlx-audio Fish S2 Pro (MLX)                                   │
│  TTS 合成（~100-200ms/句）                                      │
│    ↓                                                           │
│  sounddevice 播放                                              │
│                                                                │
│  全部句子播完 ──────────────────→ { type:'end' } ─────────────→│──→ iPad 关闭对话框
│                                                                │
└────────────────────────────────────────────────────────────────┘
                                          │ WebSocket :3300/ws
                                     ┌────┴────┐
                                     │  iPad   │
                                     │voice-   │
                                     │dialog   │
                                     └─────────┘
```

## 端到端延迟估算

| 阶段 | 时间 |
|------|------|
| 唤醒词检测 | <100ms |
| 录音（含尾部静音检测） | 用户说话时长 + 800ms |
| MLX Whisper 转录 | ~1000ms |
| OpenClaw LLM 首句生成 | ~500ms |
| Fish Speech TTS 首包 | ~150ms |
| **唤醒 → 首句播放** | **≈ 1.8s（不含录音时长）** |

## 组件选型

| 组件 | 选型 | 说明 |
|------|------|------|
| 唤醒词 | openwakeword | 免费开源，离线，可训练自定义词 |
| VAD | silero-vad | 精准静音检测，PyTorch |
| 录音 | sounddevice | 跨平台，USB 麦克风支持 |
| ASR | mlx-whisper large-v3 | Apple Silicon Metal 加速，中英双语 |
| LLM | OpenClaw Gateway | 调用 `sessions.send` RPC，SSE 流式回复 |
| TTS | mlx-audio Fish S2 Pro | `mlx-community/fishaudio-s2-pro-8bit-mlx`，本地音色克隆 |
| 播放 | sounddevice | 直接输出至 Mac Mini 音频设备 |

## 音色定制

Fish Speech S2 Pro 支持参考音频克隆：
1. 准备 30~60s 目标音色的干净音频（如蜡笔小新片段）
2. 存为 `voice-agent/ref_voices/<name>.wav`
3. 在 `.env` 中设置 `REF_VOICE_PATH` 和 `REF_VOICE_TEXT`
4. 首次启动时自动提取音色向量 → `ref_voices/<name>.npy`

## Node.js 新增接口

仅接受 127.0.0.1 连接，供 Python voice-agent 调用：

```
POST /internal/voice/send
  Body: { text: string, sessionKey?: string }
  Response: SSE text/event-stream
    data: { type: 'delta', text: '...' }  ← LLM token
    data: { type: 'done' }

POST /internal/voice/event
  Body: { type: 'listening'|'said'|'reply'|'end', text?: string }
  Response: { ok: true }
```

## 目录结构

```
smart-home-agent/
├── smart-home-hub/          ← Node.js 服务（已有）
│   └── server/
│       ├── openclaw.js      ← 新增 operator.write scope
│       └── server.js        ← 新增 /internal/voice/* 接口
└── voice-agent/             ← Python 语音服务（新增）
    ├── main.py
    ├── wake_word.py
    ├── recorder.py
    ├── asr.py
    ├── sentence_chunker.py
    ├── tts.py
    ├── player.py
    ├── hub_client.py
    ├── requirements.txt
    └── .env.example
```

## 启动方式

```bash
# 1. 启动 Node.js Hub 服务
cd smart-home-hub && npm start

# 2. 启动 Python 语音服务（新开终端）
cd voice-agent
cp .env.example .env   # 填入配置
pip install -r requirements.txt
python main.py
```
