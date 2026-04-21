// <system-footer> — 底部状态条 + 系统时钟
import { BaseComponent, esc } from '../core/base-component.js';
import { TOPICS } from '../core/topics.js';

const pad = (n) => String(n).padStart(2, '0');

export class SystemFooter extends BaseComponent {
  init() {
    this.watch(TOPICS.SYS_SUMMARY);
    this._timer = setInterval(() => {
      if (!this._mounted) return;
      const el = this.querySelector('.btm-right');
      if (el) el.textContent = this._timeStr();
    }, 1000);
  }
  destroy() { clearInterval(this._timer); }

  _timeStr() {
    const d = new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  render() {
    const s = this.data(TOPICS.SYS_SUMMARY) || {};
    return `
      <div class="btm">
        <span class="btm-stat ${s.gateway_ok ? 'ok' : 'err'}">Gateway</span>
        <span class="btm-sep"></span>
        <span class="btm-stat ${s.model_ok ? 'ok' : 'err'}">FunctionGemma</span>
        <span class="btm-sep"></span>
        <span class="btm-stat ok">${s.nodes_on ?? 0} nodes online</span>
        ${s.nodes_off ? `
          <span class="btm-sep"></span>
          <span class="btm-stat warn">${s.nodes_off} node${s.nodes_off > 1 ? 's' : ''} offline</span>` : ''}
        <span class="btm-right">${esc(this._timeStr())}</span>
      </div>
    `;
  }
}

customElements.define('system-footer', SystemFooter);
