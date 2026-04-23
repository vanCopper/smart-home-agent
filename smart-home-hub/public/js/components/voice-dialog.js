// <voice-dialog> — 全屏毛玻璃对话 overlay
//   监听 voice/event：
//     type='listening' → 弹出，圆圈变红，等待识别
//     type='said'  → 更新用户说的话
//     type='reply' → 更新 Agent 回复
//     type='end'   → 关闭
//   也可由其它组件通过事件 voice-dialog:open { said, reply } 打开
import { BaseComponent, esc } from '../core/base-component.js';
import { TOPICS } from '../core/topics.js';
import { wsClient } from '../core/ws-client.js';

export class VoiceDialog extends BaseComponent {
  init() {
    this._said = '';
    this._reply = '';
    this._open = false;
    this._listening = false;
    this._closeTimer = null;

    this._unsubWs = wsClient.subscribe(TOPICS.VOICE_EVENT, (ev) => {
      if (!ev) return;
      if (ev.type === 'listening') {
        this._listening = true; this._said = ''; this._reply = '';
        this._open = true; clearTimeout(this._closeTimer);
      } else if (ev.type === 'said') {
        this._listening = false; this._said = ev.text;
        this._open = true; this._delayAutoClose(8000);
      } else if (ev.type === 'reply') {
        this._listening = false; this._reply = ev.text;
        this._open = true; this._delayAutoClose(6000);
      } else if (ev.type === 'end') {
        this._open = false; this._listening = false;
      }
      this._renderAndBind();
    });
    this._unsubs.push(this._unsubWs);

    this.on('.dlg', 'click', () => this._close());
    this.on('.dlg-box', 'click', (e) => e.stopPropagation());
    this.on('.dlg-tap', 'click', () => this._close());
  }

  _delayAutoClose(ms) {
    clearTimeout(this._closeTimer);
    this._closeTimer = setTimeout(() => { this._close(); }, ms);
  }
  _close() {
    this._open = false;
    this._listening = false;
    this._said = '';
    this._reply = '';
    this._renderAndBind();
  }

  render() {
    return `
      <div class="dlg ${this._open ? 'on' : ''} ${this._listening ? 'listening' : ''}">
        <div class="dlg-box">
          <div class="dlg-ring"><div class="dlg-core"></div></div>
          ${this._listening ? '<div class="dlg-listening">正在聆听… · Listening…</div>' : ''}
          <div class="dlg-said">${esc(this._said || '')}</div>
          <div class="dlg-reply">${esc(this._reply || '')}</div>
          <div class="dlg-tap">点击返回 · Tap to dismiss</div>
        </div>
      </div>
    `;
  }
}

customElements.define('voice-dialog', VoiceDialog);
