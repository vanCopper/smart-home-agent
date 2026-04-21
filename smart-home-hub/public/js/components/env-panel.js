// <env-panel> — 室内/室外温湿度 + AQI
import { BaseComponent, esc } from '../core/base-component.js';
import { TOPICS } from '../core/topics.js';

export class EnvPanel extends BaseComponent {
  init() {
    this.watch(TOPICS.ENV_INDOOR);
    this.watch(TOPICS.ENV_OUTDOOR);
  }

  render() {
    const inn = this.data(TOPICS.ENV_INDOOR) || {};
    const out = this.data(TOPICS.ENV_OUTDOOR) || {};
    return `
      <div class="c">
        <div class="cl"><span class="cl-dot" style="background:var(--teal)"></span>Environment 环境</div>
        <div class="env-grid">
          <div class="env-box t">
            <div class="env-label">室内 Indoor</div>
            <div class="env-val">${inn.temp_c ?? '—'}<span class="env-unit">°C</span></div>
          </div>
          <div class="env-box h">
            <div class="env-label">湿度 Humidity</div>
            <div class="env-val">${inn.humidity_pct ?? '—'}<span class="env-unit">%</span></div>
          </div>
          <div class="env-box o">
            <div class="env-label">室外 Outdoor</div>
            <div class="env-val">${out.temp_c ?? '—'}<span class="env-unit">°C</span></div>
          </div>
          <div class="env-box a">
            <div class="env-label">AQI 空气</div>
            <div class="env-val">${out.aqi ?? '—'} <span class="env-unit">${esc(out.aqi_label || '')}</span></div>
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define('env-panel', EnvPanel);
