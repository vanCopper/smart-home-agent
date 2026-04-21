// server/topics.js
// ────────────────────────────────────────────────────────────────
// 所有 WebSocket topic 的集中定义。前后端共享的 source of truth。
// 前端订阅时用 topic 字符串；新增 topic 只需在这里登记，
// 然后在 mock/*.js 或真实数据源里 publish 对应事件即可。
// ────────────────────────────────────────────────────────────────

export const TOPICS = {
  // 主屏 Hub
  CLOCK:          'clock/tick',          // { iso, hour, minute, second, weekday, date }
  WEATHER:        'weather/current',     // { temp, desc_zh, desc_en, low, high, city, uv, wind_kmh, rain_pct, sunset }
  ENV_INDOOR:     'env/indoor',          // { temp_c, humidity_pct }
  ENV_OUTDOOR:    'env/outdoor',         // { temp_c, aqi, aqi_label }
  DEVICES_LIST:   'devices/list',        // Device[] 全量快照
  DEVICE_STATE:   'devices/state',       // { id, state: 'on'|'off'|'warn', status_text } 单设备变更
  SCHEDULE_TODAY: 'schedule/today',      // ScheduleItem[]
  SCHEDULE_INFO:  'schedule/tomorrow',   // { count, summary_zh }
  CAMERA_LIST:    'cameras/list',        // Camera[] { id, name_zh, name_en, stream_url, live }
  SCENES_LIST:    'scenes/list',         // Scene[] { id, name_zh, name_en, icon, desc }

  // 语音 / 对话
  VOICE_STATE:    'voice/state',         // { wake_word, gateway_ok, model, today_energy_kwh }
  VOICE_EVENT:    'voice/event',         // { type: 'said'|'reply'|'end', text }

  // 系统面板
  GW_STATUS:      'system/gateway',      // { running, ws, latency_ms, port, sessions, today_calls, mem_used, mem_total, cpu_pct, uptime }
  LLM_STATUS:     'system/llm',          // LLMStatus[] { name, status:'active'|'standby'|'offline', latency_ms, calls_today, metric:{label,value} }
  NODES_LIST:     'system/nodes',        // Node[] { name, meta, online, ping_ms|null }
  TOOL_LOG:       'system/tool-log',     // 全量快照 ToolCall[]
  TOOL_LOG_APPEND:'system/tool-log/append', // 追加一条 ToolCall
  ENERGY:         'system/energy',       // { today_kwh, cost_cny, hourly:number[24], month_kwh, vs_yesterday_pct }
  SYS_SUMMARY:    'system/summary',      // { nodes_on, nodes_off, gateway_ok, model_ok }
};

// Topic 的默认更新频率（ms）—— mock 用
export const TOPIC_TICK = {
  [TOPICS.CLOCK]:       1000,
  [TOPICS.ENV_INDOOR]:  5000,
  [TOPICS.ENV_OUTDOOR]: 15000,
  [TOPICS.GW_STATUS]:   3000,
  [TOPICS.LLM_STATUS]:  5000,
  [TOPICS.NODES_LIST]:  8000,
  [TOPICS.ENERGY]:      10000,
  [TOPICS.SYS_SUMMARY]: 5000,
  [TOPICS.TOOL_LOG_APPEND]: 12000, // 大概每 12s 一条
};
