// <voice-bar> — 底部通栏。
//   点击：打招呼（voice.greet RPC）
//   长按或带 `data-action="system"` 的子节点：跳转到系统面板
import { BaseComponent, esc } from '../core/base-component.js';
import { TOPICS } from '../core/topics.js';
import { wsClient } from '../core/ws-client.js';
import { go } from '../core/router.js';

export class VoiceBar extends BaseComponent {
  init() {
    this.watch(TOPICS.VOICE_STATE);

    this.on('.bar', 'click', (e) => {
      // 点击右侧 "系统" 区域 → 进入系统面板
      if (e.target.closest('[data-action="system"]')) {
        go('system');
        return;
      }
      wsClient.rpc('voice.greet').catch(() => {});
    });
  }

  render() {
    const s = this.data(TOPICS.VOICE_STATE) || {};
    const gwOk = s.gateway_ok !== false;
    return `
      <div class="bar tap">
        <div class="bar-dot ${gwOk ? '' : 'off'}"></div>
        <div class="bar-text">
          说 <b>"${esc(s.wake_word_zh || '小管家')}"</b> 开始对话 ·
          Say <b>"${esc(s.wake_word_en || 'Hey Home')}"</b>
        </div>
        <div class="bar-right" data-action="system" title="打开系统面板">
          <span class="bar-tag ${gwOk ? '' : 'off'}">Gateway</span>
          <span class="bar-tag">${esc(s.model || 'FunctionGemma')}</span>
          <span>Today ${s.today_energy_kwh ?? '—'} kWh</span>
        </div>
      </div>
    `;
  }
}

customElements.define('voice-bar', VoiceBar);
