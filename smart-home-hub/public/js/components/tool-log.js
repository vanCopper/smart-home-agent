// <tool-log> — Tool Call 日志流。接受全量快照 + 增量追加
import { BaseComponent, esc } from '../core/base-component.js';
import { TOPICS } from '../core/topics.js';
import { wsClient } from '../core/ws-client.js';

const MAX_KEEP = 50;

export class ToolLog extends BaseComponent {
  init() {
    /** @type {Array<{id,time,tool,input,latency,status}>} */
    this._items = [];
    this._filter = 'all';
    this._newIds = new Set();

    this._unsubs.push(wsClient.subscribe(TOPICS.TOOL_LOG, (list) => {
      this._items = Array.isArray(list) ? [...list].reverse() : [];
      this._renderAndBind();
    }));
    this._unsubs.push(wsClient.subscribe(TOPICS.TOOL_LOG_APPEND, (entry) => {
      if (!entry) return;
      this._items.unshift(entry);
      if (this._items.length > MAX_KEEP) this._items.length = MAX_KEEP;
      this._newIds.add(entry.id);
      this._renderAndBind();
      setTimeout(() => this._newIds.delete(entry.id), 400);
    }));

    this.on('.log-fbtn', 'click', (_, el) => {
      this._filter = el.dataset.filter;
      this._renderAndBind();
    });
  }

  _latencyClass(ms) {
    if (ms < 100)  return 'fast';
    if (ms < 2000) return 'mid';
    return 'slow';
  }

  _formatLatency(ms) {
    return ms >= 1000 ? (ms/1000).toFixed(1) + 's' : ms + 'ms';
  }

  _passFilter(it) {
    if (this._filter === 'all')  return true;
    if (this._filter === 'fast') return it.latency < 100;
    if (this._filter === 'llm')  return it.latency >= 100;
    if (this._filter === 'fail') return it.status === 'fail' || it.status === 'skip';
    return true;
  }

  render() {
    const items = this._items.filter((it) => this._passFilter(it));
    return `
      <div class="c">
        <div class="log-head-row">
          <div class="cl" style="margin-bottom:0"><span class="cl-dot" style="background:var(--amber)"></span>Tool Call Log 调用日志</div>
          <div class="log-filter">
            ${['all','fast','llm','fail'].map(f => `
              <button class="log-fbtn ${f===this._filter?'active':''}" data-filter="${f}">${f[0].toUpperCase()+f.slice(1)}</button>
            `).join('')}
          </div>
        </div>
        <div class="log-columns">
          <span>Time</span><span>Tool</span><span>Input 输入</span>
          <span style="text-align:right">Latency</span><span style="text-align:center">Status</span>
        </div>
        <div class="log-list no-scrollbar">
          ${items.map(it => `
            <div class="log-item ${this._newIds.has(it.id) ? 'entering' : ''}">
              <span class="log-time">${esc(it.time)}</span>
              <span class="log-tool">${esc(it.tool)}</span>
              <span class="log-input">${esc(it.input)}</span>
              <span class="log-lat ${this._latencyClass(it.latency)}">${this._formatLatency(it.latency)}</span>
              <span class="log-st ${esc(it.status)}">${it.status === 'ok' ? 'OK' : it.status === 'fail' ? 'Fail' : 'Route'}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }
}

customElements.define('tool-log', ToolLog);
