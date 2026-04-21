// <energy-panel> — 今日用电 + 24h 柱状图 + 月度对比
import { BaseComponent, esc } from '../core/base-component.js';
import { TOPICS } from '../core/topics.js';

const pad = (n) => String(n).padStart(2, '0');

export class EnergyPanel extends BaseComponent {
  init() { this.watch(TOPICS.ENERGY); }

  render() {
    const e = this.data(TOPICS.ENERGY) || {};
    const hourly = e.hourly || new Array(24).fill(0);
    const nowH = new Date().getHours();
    const maxH = Math.max(...hourly.slice(0, nowH + 1), 0.001);

    const barsHtml = hourly.map((v, i) => {
      if (i > nowH) return `<div class="en-bar" style="height:0%;opacity:.2"></div>`;
      const pct = Math.max(Math.round((v / maxH) * 100), 5);
      const high = v > 0.35 ? 'high' : '';
      return `<div class="en-bar ${high}" style="height:${pct}%"><div class="en-bar-tip">${(v*1000).toFixed(0)}Wh</div></div>`;
    }).join('');

    const hourLabels = [];
    for (let i = 0; i <= 23; i++) if (i % 4 === 0) hourLabels.push(`<span>${pad(i)}</span>`);

    const delta = e.vs_yesterday_pct;
    const deltaStr = delta == null ? '—' : (delta > 0 ? '+' : '') + delta.toFixed(1) + '%';

    return `
      <div class="c">
        <div class="cl"><span class="cl-dot" style="background:var(--coral)"></span>Energy 能耗</div>
        <div class="en-top">
          <div class="en-box">
            <div class="en-box-label">Today 今日</div>
            <div class="en-box-val" style="color:var(--blue-fg)">${e.today_kwh ?? '—'}<span class="en-box-unit"> kWh</span></div>
          </div>
          <div class="en-box">
            <div class="en-box-label">Cost 费用</div>
            <div class="en-box-val" style="color:var(--coral-fg)">¥${e.cost_cny ?? '—'}</div>
          </div>
        </div>
        <div class="en-chart">
          <div class="en-chart-label">Hourly usage 每小时用电</div>
          <div class="en-bars">${barsHtml}</div>
          <div class="en-hour-labels">${hourLabels.join('')}</div>
        </div>
        <div class="en-foot">
          <div class="en-foot-box">本月累计<span>${e.month_kwh ?? '—'} kWh</span></div>
          <div class="en-foot-box ${delta != null && delta < 0 ? 'good' : ''}">对比昨日<span>${esc(deltaStr)}</span></div>
        </div>
      </div>
    `;
  }
}

customElements.define('energy-panel', EnergyPanel);
