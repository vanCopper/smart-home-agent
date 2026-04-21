// System page — 组装系统面板六模块
import '../components/system-header.js';
import '../components/gateway-status.js';
import '../components/llm-models.js';
import '../components/nodes-list.js';
import '../components/tool-log.js';
import '../components/energy-panel.js';
import '../components/system-footer.js';

export function mountSystemPage(root) {
  root.innerHTML = `
    <div class="panel">
      <system-header></system-header>
      <gateway-status></gateway-status>
      <llm-models></llm-models>
      <nodes-list></nodes-list>
      <tool-log></tool-log>
      <energy-panel></energy-panel>
      <system-footer></system-footer>
    </div>
  `;
}
