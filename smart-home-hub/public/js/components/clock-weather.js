// <clock-weather>
// 大字时钟 + 日期 + 天气详情；时钟用 requestAnimationFrame 精准走秒
import { BaseComponent, esc } from '../core/base-component.js';
import { TOPICS } from '../core/topics.js';

const pad = (n) => String(n).padStart(2, '0');

export class ClockWeather extends BaseComponent {
  init() {
    this.watch(TOPICS.CLOCK);
    this.watch(TOPICS.WEATHER);
    // 自己本地走秒，避免受网络波动影响显示
    this._timer = setInterval(() => {
      if (!this._mounted) return;
      const t = this.querySelector('.time');
      if (t) t.innerHTML = this._clockHtml(new Date());
    }, 1000);
  }

  destroy() { clearInterval(this._timer); }

  _clockHtml(d) {
    return `${pad(d.getHours())}<span class="time-colon">:</span>${pad(d.getMinutes())}<span class="time-sec">${pad(d.getSeconds())}</span>`;
  }

  render() {
    const clock = this.data(TOPICS.CLOCK);
    const w = this.data(TOPICS.WEATHER) || {};
    const d = new Date();

    const dateLine = clock?.date
      || `${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()]}, ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;

    return `
      <div class="c cw-inner">
        <div class="time">${this._clockHtml(d)}</div>
        <div class="date-line">${esc(dateLine)}</div>
        <div class="weather-block">
          <div class="w-main">
            <div class="w-temp">${w.temp ?? '—'}°</div>
            <div>
              <div class="w-desc">${esc(w.desc_zh || '—')}<br>${esc(w.desc_en || '')}</div>
              <div class="w-range">${w.low ?? '—'}° / ${w.high ?? '—'}° · ${esc(w.city || '')}</div>
            </div>
          </div>
          <div class="w-detail">
            <div class="w-item">
              <div class="w-item-label">UV 紫外线</div>
              <div class="w-item-val" style="color:var(--amber-fg)">${w.uv ?? '—'} ${esc(w.uv_label || '')}</div>
            </div>
            <div class="w-item">
              <div class="w-item-label">Wind 风速</div>
              <div class="w-item-val" style="color:var(--teal-fg)">${w.wind_kmh ?? '—'} km/h</div>
            </div>
            <div class="w-item">
              <div class="w-item-label">Rain 降雨</div>
              <div class="w-item-val" style="color:var(--blue-fg)">${w.rain_pct ?? '—'}%</div>
            </div>
            <div class="w-item">
              <div class="w-item-label">日落 Sunset</div>
              <div class="w-item-val" style="color:var(--coral-fg)">${esc(w.sunset || '—')}</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define('clock-weather', ClockWeather);
