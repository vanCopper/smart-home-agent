// public/js/core/base-component.js
// ────────────────────────────────────────────────────────────────
// Web Component 基类 —— 刻意不用 Shadow DOM
//
//   • 不用 Shadow DOM：设计稿里 CSS variables 和通用样式靠全局
//     cascade 起作用，全塞进 shadow 成本高且失去自动 light/dark 同步。
//   • 子类实现 render()：返回 HTML 字符串。首次挂载 + store 更新时调用。
//   • watch(key, mapFn?)：订阅 store 里某个 key，变更后自动重渲染。
//   • on(selector, event, handler)：事件委托，节省重绘后重新绑定。
//   • 生命周期：connectedCallback/disconnectedCallback 由 Web Component 提供。
// ────────────────────────────────────────────────────────────────

import { store } from './store.js';

export class BaseComponent extends HTMLElement {
  constructor() {
    super();
    this._unsubs = [];
    this._watches = new Map();   // key -> latest value
    this._mounted = false;
  }

  connectedCallback() {
    this._mounted = true;
    this.init?.();
    this._renderAndBind();
  }

  disconnectedCallback() {
    this._mounted = false;
    for (const u of this._unsubs) { try { u(); } catch {} }
    this._unsubs = [];
    this.destroy?.();
  }

  /**
   * 订阅 store 某个 key，自动重渲染。
   * @param {string} key
   * @param {(raw:any)=>any} [mapFn] 可选转换
   */
  watch(key, mapFn) {
    const unsub = store.subscribe(key, (raw) => {
      const v = mapFn ? mapFn(raw) : raw;
      this._watches.set(key, v);
      if (this._mounted) this._renderAndBind();
    });
    this._unsubs.push(unsub);
    return this;
  }

  /** 获取最新 watch 值 */
  data(key) { return this._watches.get(key); }

  _renderAndBind() {
    const html = this.render?.();
    if (html !== undefined) this.innerHTML = html;
    this.afterRender?.();
  }

  /**
   * 事件委托。selector === ':host' 表示绑定到组件根。
   */
  on(selector, event, handler) {
    const root = this;
    const fn = (e) => {
      if (selector === ':host') return handler(e, root);
      const match = e.target.closest(selector);
      if (match && root.contains(match)) handler(e, match);
    };
    root.addEventListener(event, fn);
    this._unsubs.push(() => root.removeEventListener(event, fn));
    return this;
  }
}

/** 简单的 HTML 转义 */
export function esc(s) {
  return String(s ?? '')
    .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
    .replaceAll('"','&quot;').replaceAll("'",'&#39;');
}
