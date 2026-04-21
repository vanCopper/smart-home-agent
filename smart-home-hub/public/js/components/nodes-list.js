// <nodes-list> — 设备节点在线状态
import { BaseComponent, esc } from '../core/base-component.js';
import { TOPICS } from '../core/topics.js';

export class NodesList extends BaseComponent {
  init() { this.watch(TOPICS.NODES_LIST); }

  render() {
    const list = this.data(TOPICS.NODES_LIST) || [];
    return `
      <div class="c">
        <div class="cl"><span class="cl-dot" style="background:var(--teal)"></span>Nodes 节点</div>
        <div class="node-list">
          ${list.map(n => `
            <div class="nd">
              <div class="nd-dot ${n.online ? 'on' : 'off'}"></div>
              <div class="nd-info">
                <div class="nd-name">${esc(n.name)}</div>
                <div class="nd-meta">${esc(n.meta)}</div>
              </div>
              <div class="nd-ping ${esc(n.ping_class || '')}">${esc(n.ping_label)}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }
}

customElements.define('nodes-list', NodesList);
