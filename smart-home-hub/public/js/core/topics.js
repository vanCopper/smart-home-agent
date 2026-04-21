// public/js/core/topics.js
// ────────────────────────────────────────────
// 前端 topic 常量 —— 必须与 server/topics.js 一致。
// 后续新增 topic 请同时更新两侧。
// ────────────────────────────────────────────

export const TOPICS = Object.freeze({
  CLOCK:          'clock/tick',
  WEATHER:        'weather/current',
  ENV_INDOOR:     'env/indoor',
  ENV_OUTDOOR:    'env/outdoor',
  DEVICES_LIST:   'devices/list',
  DEVICE_STATE:   'devices/state',
  SCHEDULE_TODAY: 'schedule/today',
  SCHEDULE_INFO:  'schedule/tomorrow',
  CAMERA_LIST:    'cameras/list',
  SCENES_LIST:    'scenes/list',
  VOICE_STATE:    'voice/state',
  VOICE_EVENT:    'voice/event',

  GW_STATUS:      'system/gateway',
  LLM_STATUS:     'system/llm',
  NODES_LIST:     'system/nodes',
  TOOL_LOG:       'system/tool-log',
  TOOL_LOG_APPEND:'system/tool-log/append',
  ENERGY:         'system/energy',
  SYS_SUMMARY:    'system/summary',
});
