// <scenes-panel> — 4 个场景按钮；点击发 scene.run RPC，对话由 voice-dialog 处理
import { BaseComponent, esc } from '../core/base-component.js';
import { TOPICS } from '../core/topics.js';
import { wsClient } from '../core/ws-client.js';

export class ScenesPanel extends BaseComponent {
  init() {
    this.watch(TOPICS.SCENES_LIST);
    this.on('[data-scene-id]', 'click', (_, el) => {
      const id = el.dataset.sceneId;
      const name_zh = el.dataset.sceneZh;
      wsClient.rpc('scene.run', { id, name_zh }).catch((e) => console.warn('scene.run failed', e));
    });
  }

  render() {
    const list = this.data(TOPICS.SCENES_LIST) || [];
    return `
      <div class="c">
        <div class="cl"><span class="cl-dot" style="background:var(--amber)"></span>Scenes 场景</div>
        <div class="act-grid">
          ${list.map(s => `
            <div class="act" data-scene-id="${esc(s.id)}" data-scene-zh="${esc(s.name_zh.replace('模式',''))}">
              <div class="act-icon ${esc(s.color || '')}">${esc(s.icon)}</div>
              <div>
                <div class="act-name">${esc(s.name_zh)}</div>
                <div class="act-desc">${esc(s.desc)}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }
}

customElements.define('scenes-panel', ScenesPanel);
