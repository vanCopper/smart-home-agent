// server/mock/system.js
// ────────────────────────────────────────────────
// 系统面板 mock 数据源。
// ────────────────────────────────────────────────

const START_TS = Date.now() - (14 * 24 + 6) * 3600_000 - 32 * 60_000; // ~14d 6h 32m ago

export function gatewaySnapshot() {
  return {
    running: true,
    ws: 'connected',
    latency_ms: 2 + Math.floor(Math.random() * 4),
    port: 18789,
    sessions: 2,
    today_calls: 140 + Math.floor(Math.random() * 15),
    mem_used_gb: 4.0 + Math.random() * 0.4,
    mem_total_gb: 8,
    cpu_pct: 18 + Math.floor(Math.random() * 12),
    uptime_ms: Date.now() - START_TS,
  };
}

export function llmSnapshot() {
  return [
    {
      name: 'FunctionGemma 270M',
      status: 'active',
      stats: [
        { label: 'Avg latency', value: (360 + Math.floor(Math.random()*60)) + 'ms' },
        { label: 'Today calls', value: String(120 + Math.floor(Math.random()*12)) },
        { label: 'Accuracy',    value: '96.2%' },
      ],
    },
    {
      name: 'Intent Router 路由器',
      status: 'active',
      stats: [
        { label: 'Avg latency', value: (15 + Math.floor(Math.random()*8)) + 'ms' },
        { label: 'Today hits',  value: String(85 + Math.floor(Math.random()*10)) },
        { label: 'Hit rate',    value: '60.5%' },
      ],
    },
    {
      name: 'Claude Sonnet (Cloud)',
      status: 'standby',
      stats: [
        { label: 'Avg latency', value: '4.2s' },
        { label: 'Today calls', value: '23' },
        { label: 'Cost 费用',   value: '$0.18' },
      ],
    },
  ];
}

export function nodesSnapshot() {
  return [
    { name:'Mac mini M4',      meta:'Gateway host · macOS 26', online:true,  ping_label:'local', ping_class:'good' },
    { name:'iPad Hub Screen',  meta:'Safari PWA · Web client', online:true,  ping_label:(2+Math.floor(Math.random()*3))+'ms', ping_class:'good' },
    { name:'iPhone 15 Pro',    meta:'Telegram channel',        online:true,  ping_label:(25+Math.floor(Math.random()*10))+'ms', ping_class:'good' },
    { name:'USB Mic Array',    meta:'ReSpeaker · 4-mic',       online:true,  ping_label:'1ms', ping_class:'good' },
    { name:'Apple Watch',      meta:'Companion · 未配对',      online:false, ping_label:'offline', ping_class:'' },
  ];
}

// ── Tool call log ─────────────────────────
const TOOL_POOL = [
  { tool:'air_conditioner', input:'"空调调到25度"',   latency:42,  status:'ok'  },
  { tool:'tv_control',      input:'"关掉电视"',       latency:38,  status:'ok'  },
  { tool:'light_control',   input:'"卧室灯调暗一点"', latency:420, status:'ok'  },
  { tool:'scene_engine',    input:'"启动回家模式"',   latency:680, status:'ok'  },
  { tool:'robot_vacuum',    input:'"开始扫地"',       latency:55,  status:'ok'  },
  { tool:'weather_query',   input:'"今天会下雨吗"',   latency:4200,status:'ok'  },
  { tool:'calendar_read',   input:'"今天有什么安排"', latency:3800,status:'ok'  },
  { tool:'light_control',   input:'"打开书房灯"',     latency:35,  status:'ok'  },
  { tool:'purifier_status', input:'"净水器什么状态"', latency:510, status:'ok'  },
  { tool:'air_conditioner', input:'"太热了"',         latency:620, status:'skip'},
  { tool:'music_control',   input:'"播放轻音乐"',     latency:5100,status:'fail'},
  { tool:'light_control',   input:'"全屋关灯"',       latency:48,  status:'ok'  },
];

const pad = n => String(n).padStart(2, '0');
function fmtTime(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }

function makeEntry(minsAgo) {
  const base = TOOL_POOL[Math.floor(Math.random() * TOOL_POOL.length)];
  const d = new Date(Date.now() - minsAgo * 60_000);
  return { time: fmtTime(d), ...base, id: `log-${d.getTime()}-${Math.random().toString(36).slice(2,7)}` };
}

// 初始化 12 条历史日志
const history = [];
for (let i = 11; i >= 0; i--) history.push(makeEntry(i * 2 + Math.floor(Math.random()*3)));

export function toolLogSnapshot() { return history.slice(-30); }
export function appendToolLogEntry() {
  const entry = makeEntry(0);
  history.push(entry);
  if (history.length > 100) history.shift();
  return entry;
}

// ── Energy ────────────────────────────────
export function energySnapshot() {
  const now = new Date().getHours();
  const hourly = new Array(24).fill(0).map((_, i) => {
    if (i > now) return 0;
    const base = [0.1,0.1,0.1,0.05,0.05,0.05,0.15,0.3,0.4,0.35,0.25,0.2,0.3,0.35,0.4,0.45,0.4,0.38,0.3,0.25,0.2,0.18,0.15,0.12][i];
    return Math.round((base + (Math.random() - 0.5) * 0.04) * 1000) / 1000;
  });
  const today = hourly.reduce((a,b) => a+b, 0);
  return {
    today_kwh: Math.round(today * 10) / 10,
    cost_cny: Math.round(today * 0.9 * 10) / 10,
    hourly,
    month_kwh: 128.4,
    vs_yesterday_pct: -12.3,
  };
}

export function sysSummarySnapshot() {
  const nodes = nodesSnapshot();
  return {
    gateway_ok: true,
    model_ok: true,
    nodes_on: nodes.filter(n => n.online).length,
    nodes_off: nodes.filter(n => !n.online).length,
  };
}
