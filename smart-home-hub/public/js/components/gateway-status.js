// <gateway-status> — Gateway 状态（延迟/端口/会话数 + CPU 和内存进度条）
import { BaseComponent, esc } from '../core/base-component.js';
import { TOPICS } from '../core/topics.js';

export class GatewayStatus extends BaseComponent {
  init() { this.watch(TOPICS.GW_STATUS); }

  render() {
    const g = this.data(TOPICS.GW_STATUS) || {};
    const memPct = g.mem_total_gb ? Math.round((g.mem_used_gb / g.mem_total_gb) * 100) : 0;
    return `
      <div class="c">
        <div class="cl"><span class="cl-dot" style="background:var(--green)"></span>Gateway 网关</div>
        <div class="gw-metrics">
          <div class="gw-row">
            <span class="gw-label">Status 状态</span>
            <span class="gw-val ${g.running ? 'ok' : 'err'}">● ${g.running ? 'Running' : 'Stopped'}</span>
          </div>
          <div class="gw-row">
            <span class="gw-label">WebSocket</span>
            <span class="gw-val ok">${esc(g.ws || 'Connected')}</span>
          </div>
          <div class="gw-row">
            <span class="gw-label">Latency 延迟</span>
            <span class="gw-val ${g.latency_ms > 20 ? 'warn' : 'ok'}">${g.latency_ms ?? '—'} ms</span>
          </div>
          <div class="gw-row">
            <span class="gw-label">Port 端口</span>
            <span class="gw-val">${g.port ?? '—'}</span>
          </div>
          <div class="gw-row">
            <span class="gw-label">Sessions 会话</span>
            <span class="gw-val">${g.sessions ?? 0} active</span>
          </div>
          <div class="gw-row">
            <span class="gw-label">Today Calls</span>
            <span class="gw-val">${g.today_calls ?? 0}</span>
          </div>
        </div>
        <div class="gw-bar-row">
          <div class="gw-bar-label">Memory 内存 · ${(g.mem_used_gb ?? 0).toFixed(1)} / ${g.mem_total_gb ?? 0} GB</div>
          <div class="gw-bar-track"><div class="gw-bar-fill" style="width:${memPct}%;background:var(--blue)"></div></div>
          <div class="gw-bar-label" style="margin-top:8px">CPU · ${g.cpu_pct ?? 0}%</div>
          <div class="gw-bar-track"><div class="gw-bar-fill" style="width:${g.cpu_pct ?? 0}%;background:var(--teal)"></div></div>
        </div>
      </div>
    `;
  }
}

customElements.define('gateway-status', GatewayStatus);
