// server/mock/hub.js
// ────────────────────────────────────────────────
// 主屏相关 mock 数据源。每个 snapshot 函数负责返回
// 当前时刻该 topic 的最新数据快照。
// ────────────────────────────────────────────────

const WEEKDAY_EN = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTH_EN   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export function clockSnapshot() {
  const d = new Date();
  return {
    iso: d.toISOString(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    second: d.getSeconds(),
    weekday: WEEKDAY_EN[d.getDay()],
    date: `${WEEKDAY_EN[d.getDay()]}, ${MONTH_EN[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`,
  };
}

export function weatherSnapshot() {
  // 模拟一天的温度波动 (24h 正弦)
  const h = new Date().getHours() + new Date().getMinutes()/60;
  const base = 30.5;
  const temp = Math.round((base + 2.5 * Math.sin((h - 14) * Math.PI / 12)) * 10) / 10;
  return {
    temp: Math.round(temp),
    desc_zh: '多云转晴',
    desc_en: 'Partly Cloudy',
    low: 28,
    high: 33,
    city: 'Singapore',
    uv: 6, uv_label: 'High',
    wind_kmh: 12,
    rain_pct: 20,
    sunset: '19:08',
  };
}

let indoorTemp = 26.0;
let indoorHum  = 62;
export function envIndoorSnapshot() {
  indoorTemp += (Math.random() - 0.5) * 0.1;
  indoorHum  += (Math.random() - 0.5) * 0.8;
  indoorTemp = Math.max(22, Math.min(28, indoorTemp));
  indoorHum  = Math.max(45, Math.min(75, indoorHum));
  return {
    temp_c: Math.round(indoorTemp * 10) / 10,
    humidity_pct: Math.round(indoorHum),
  };
}

export function envOutdoorSnapshot() {
  return {
    temp_c: weatherSnapshot().temp,
    aqi: 40 + Math.floor(Math.random() * 8),
    aqi_label: 'Good',
  };
}

// ── Devices ───────────────────────────────
const DEVICES = [
  { id:'ac_living',    name_zh:'客厅空调',   name_en:'Living AC',    state:'on',   status_text:'制冷 26°C' },
  { id:'tv_living',    name_zh:'客厅电视',   name_en:'Living TV',    state:'off',  status_text:'Off' },
  { id:'light_bedroom',name_zh:'卧室灯',     name_en:'Bedroom Light',state:'on',   status_text:'暖光 60%' },
  { id:'purifier',     name_zh:'净水器',     name_en:'Water Purifier',state:'warn',status_text:'滤芯待换' },
  { id:'light_study',  name_zh:'书房灯',     name_en:'Study Light',  state:'off',  status_text:'Off' },
  { id:'robot_vacuum', name_zh:'扫地机器人', name_en:'Robot Vacuum', state:'on',   status_text:'清扫 43%' },
];
export function devicesSnapshot() { return DEVICES.map(d => ({ ...d })); }
export function toggleDevice(id) {
  const d = DEVICES.find(x => x.id === id);
  if (!d || d.state === 'warn') return null;
  d.state = d.state === 'on' ? 'off' : 'on';
  d.status_text = d.state === 'on' ? (d.id.startsWith('light') ? '暖光 60%' : 'On') : 'Off';
  return { id: d.id, state: d.state, status_text: d.status_text };
}

// ── Schedule ──────────────────────────────
const SCHEDULE = [
  { time:'16:00', title:'项目评审会', meta:'腾讯会议 · 45 min', who:'me',   now:true },
  { time:'17:30', title:'接孩子放学', meta:'预计 18:00 到家',   who:'wife' },
  { time:'18:30', title:'钢琴课 Piano', meta:'线上 · 40 min',    who:'kid'  },
  { time:'19:00', title:'快递到达',   meta:'京东 · 净水器滤芯',   who:'home' },
  { time:'20:00', title:'家庭电影之夜', meta:'客厅 · 已选片',    who:'home' },
];
export function scheduleTodaySnapshot() { return SCHEDULE.map(s => ({ ...s })); }
export function scheduleTomorrowSnapshot() {
  return { count: 3, summary_zh: '明天有 3 个日程', summary_en: 'Tomorrow · 3 events' };
}

// ── Cameras ───────────────────────────────
export function camerasSnapshot() {
  return [
    { id:'entrance', name_zh:'门口', name_en:'Entrance', stream_url:null, live:true, placeholder:'1' },
    { id:'living',   name_zh:'客厅', name_en:'Living',   stream_url:null, live:true, placeholder:'2' },
  ];
}

// ── Scenes ────────────────────────────────
export function scenesSnapshot() {
  return [
    { id:'away',    name_zh:'离家模式', name_en:'Away',     icon:'☞', color:'coral', desc:'关灯 · 关空调 · 布防' },
    { id:'home',    name_zh:'回家模式', name_en:'Home',     icon:'☜', color:'green', desc:'开灯 · 开空调 · 撤防' },
    { id:'sleep',   name_zh:'睡眠模式', name_en:'Sleep',    icon:'☾', color:'blue',  desc:'灯光渐暗 · 勿扰' },
    { id:'cinema',  name_zh:'影院模式', name_en:'Cinema',   icon:'▶', color:'amber', desc:'关灯 · 开电视 · 氛围光' },
  ];
}

// ── Voice state ───────────────────────────
export function voiceStateSnapshot() {
  return {
    wake_word_zh: '小管家',
    wake_word_en: 'Hey Home',
    gateway_ok: true,
    model: 'FunctionGemma',
    today_energy_kwh: 4.2,
  };
}
