// <camera-panel> — 两路摄像头画面。当 stream_url 不为空时渲染 <video>，
// 否则渲染 placeholder。未来接入 RTSP→HLS 后只要推送 stream_url 即可。
import { BaseComponent, esc } from '../core/base-component.js';
import { TOPICS } from '../core/topics.js';

export class CameraPanel extends BaseComponent {
  init() { this.watch(TOPICS.CAMERA_LIST); }

  render() {
    const list = this.data(TOPICS.CAMERA_LIST) || [];
    return `
      <div class="c">
        <div class="cl"><span class="cl-dot" style="background:var(--red)"></span>Camera 摄像头</div>
        <div class="cam-grid">
          ${list.map(c => `
            <div class="cam">
              ${c.live ? '<div class="cam-live">Live</div>' : ''}
              ${c.stream_url
                ? `<video src="${esc(c.stream_url)}" autoplay muted playsinline></video>`
                : `<div class="cam-placeholder">${esc(c.placeholder || '')}</div>`}
              <div class="cam-tag">${esc(c.name_zh)} ${esc(c.name_en)}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }
}

customElements.define('camera-panel', CameraPanel);
