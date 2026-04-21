// <schedule-panel> — 今日日程列表 + 明日预告
import { BaseComponent, esc } from '../core/base-component.js';
import { TOPICS } from '../core/topics.js';

export class SchedulePanel extends BaseComponent {
  init() {
    this.watch(TOPICS.SCHEDULE_TODAY);
    this.watch(TOPICS.SCHEDULE_INFO);
  }

  render() {
    const list = this.data(TOPICS.SCHEDULE_TODAY) || [];
    const tomorrow = this.data(TOPICS.SCHEDULE_INFO) || {};
    return `
      <div class="c">
        <div class="cl"><span class="cl-dot" style="background:var(--blue)"></span>Schedule 日程</div>
        <div class="sched-list">
          ${list.map(s => `
            <div class="si">
              <div class="si-time ${s.now ? 'now' : ''}">${esc(s.time)}</div>
              <div class="si-body">
                <div class="si-title">${esc(s.title)}</div>
                <div class="si-meta">${esc(s.meta)}</div>
                <span class="si-who ${esc(s.who)}">${this._whoLabel(s.who)}</span>
              </div>
            </div>
          `).join('')}
        </div>
        <div class="sched-tomorrow">
          ${esc(tomorrow.summary_en || 'Tomorrow')} · <strong>${esc(tomorrow.count ?? '—')} events</strong>
          · ${esc(tomorrow.summary_zh || '')}
        </div>
      </div>
    `;
  }

  _whoLabel(w) {
    return { me:'我', wife:'她', kid:'宝', home:'家' }[w] || w;
  }
}

customElements.define('schedule-panel', SchedulePanel);
