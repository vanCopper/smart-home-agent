// Hub page — 组装主屏的七个 Web Components。
// 仅负责布局，不直接订阅数据。
import '../components/clock-weather.js';
import '../components/env-panel.js';
import '../components/devices-panel.js';
import '../components/schedule-panel.js';
import '../components/camera-panel.js';
import '../components/scenes-panel.js';
import '../components/voice-bar.js';
import '../components/voice-dialog.js';

export function mountHubPage(root) {
  root.innerHTML = `
    <div class="hub">
      <clock-weather></clock-weather>
      <env-panel></env-panel>
      <devices-panel></devices-panel>
      <schedule-panel></schedule-panel>
      <camera-panel></camera-panel>
      <scenes-panel></scenes-panel>
      <voice-bar></voice-bar>
    </div>
    <voice-dialog></voice-dialog>
  `;
}
