// <system-header> — 返回按钮 / 标题 / uptime / 连接指示
import { BaseComponent, esc } from '../core/base-component.js';
import { TOPICS } from '../core/topics.js';
import { go } from '../core/router.js';

function fmtUptime(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

export class SystemHeader extends BaseComponent {
  init() {
    this.watch(TOPICS.GW_STATUS);
    this.on('.hdr-back', 'click', () => go('hub'));
  }

  render() {
    const gw = this.data(TOPICS.GW_STATUS) || {};
    return `
      <div class="hdr">
        <button class="hdr-back" title="返回主屏">&#8592;</button>
        <div class="hdr-title">System Panel 系统面板</div>
        <div class="hdr-uptime">Uptime ${esc(fmtUptime(gw.uptime_ms))}</div>
        <div class="hdr-live ${gw.running ? '' : 'off'}">${gw.running ? 'Connected' : 'Disconnected'}</div>
      </div>
    `;
  }
}

customElements.define('system-header', SystemHeader);
