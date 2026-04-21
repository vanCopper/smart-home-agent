// <devices-panel> — 6 个设备卡片，点击触发 devices.toggle RPC
import { BaseComponent, esc } from '../core/base-component.js';
import { TOPICS } from '../core/topics.js';
import { wsClient } from '../core/ws-client.js';

export class DevicesPanel extends BaseComponent {
  init() {
    this.watch(TOPICS.DEVICES_LIST);
    this.on('[data-dev-id]', 'click', (_, el) => {
      const id = el.dataset.devId;
      if (el.classList.contains('warn')) return;
      // 立刻本地乐观切换（不必等 server 响应），但最终由 DEVICES_LIST 覆盖
      el.classList.toggle('on');
      el.classList.toggle('off');
      wsClient.rpc('devices.toggle', { id }).catch((e) => {
        console.warn('toggle failed', e);
      });
    });
  }

  render() {
    const list = this.data(TOPICS.DEVICES_LIST) || [];
    return `
      <div class="c">
        <div class="cl"><span class="cl-dot" style="background:var(--green)"></span>Devices 设备</div>
        <div class="dev-grid">
          ${list.map(d => `
            <div class="dev ${esc(d.state)}" data-dev-id="${esc(d.id)}">
              <div class="dev-dot"></div>
              <div class="dev-name">${esc(d.name_zh)}</div>
              <div class="dev-stat">${esc(d.status_text)}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }
}

customElements.define('devices-panel', DevicesPanel);
