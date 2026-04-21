// public/js/main.js — 应用入口
// ────────────────────────────────────────────────────────────────
// 职责：
//   1. 预先绑定所有 WS topic → store 的桥接（一次性，后续不重复订阅）
//   2. 挂载两个页面
//   3. 启动 hash router
// ────────────────────────────────────────────────────────────────

import { store } from './core/store.js';
import { TOPICS } from './core/topics.js';
import { registerRoute, start } from './core/router.js';

import { mountHubPage }    from './pages/hub-page.js';
import { mountSystemPage } from './pages/system-page.js';

// 1. 订阅所有需要的 topic —— 一次建立后不管页面切换都保持订阅
store.bindTopics([
  // Hub
  TOPICS.CLOCK,
  TOPICS.WEATHER,
  TOPICS.ENV_INDOOR,
  TOPICS.ENV_OUTDOOR,
  TOPICS.DEVICES_LIST,
  TOPICS.SCHEDULE_TODAY,
  TOPICS.SCHEDULE_INFO,
  TOPICS.CAMERA_LIST,
  TOPICS.SCENES_LIST,
  TOPICS.VOICE_STATE,
  // System
  TOPICS.GW_STATUS,
  TOPICS.LLM_STATUS,
  TOPICS.NODES_LIST,
  TOPICS.ENERGY,
  TOPICS.SYS_SUMMARY,
  // TOOL_LOG 和 TOOL_LOG_APPEND 由 <tool-log> 自己订阅（它需要同时处理全量+增量）
]);

// 2. 挂载页面
const hubEl = document.getElementById('route-hub');
const sysEl = document.getElementById('route-system');
mountHubPage(hubEl);
mountSystemPage(sysEl);

// 3. 注册路由
registerRoute('hub',    hubEl);
registerRoute('system', sysEl);

// 4. 启动
start('hub');
