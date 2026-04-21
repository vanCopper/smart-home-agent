// <llm-models> — 三通道模型状态
import { BaseComponent, esc } from '../core/base-component.js';
import { TOPICS } from '../core/topics.js';

const BADGE = { active:'Active', standby:'Standby', offline:'Offline' };

export class LLMModels extends BaseComponent {
  init() { this.watch(TOPICS.LLM_STATUS); }

  render() {
    const list = this.data(TOPICS.LLM_STATUS) || [];
    return `
      <div class="c">
        <div class="cl"><span class="cl-dot" style="background:var(--purple)"></span>LLM Models 模型</div>
        <div class="llm-list">
          ${list.map(m => `
            <div class="llm-item ${esc(m.status)}">
              <div class="llm-head">
                <span class="llm-name">${esc(m.name)}</span>
                <span class="llm-badge">${esc(BADGE[m.status] || m.status)}</span>
              </div>
              <div class="llm-stats">
                ${(m.stats || []).map(s => `
                  <div class="llm-stat">${esc(s.label)}<span>${esc(s.value)}</span></div>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }
}

customElements.define('llm-models', LLMModels);
