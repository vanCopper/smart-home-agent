// public/js/core/store.js
// ────────────────────────────────────────────
// 极简 reactive store：按 key (通常是 topic) 存储最新数据，
// 组件可订阅变更。store 在应用启动时预绑定所有 WS topic，
// 组件只读最新值 + 订阅变更，不直接碰 ws。
// ────────────────────────────────────────────

import { wsClient } from './ws-client.js';

class Store {
  constructor() {
    this.state = Object.create(null);
    this.listeners = new Map();         // key -> Set<handler>
    this.wsUnsubs = new Map();          // key -> unsub()
  }

  /** 把一个 topic 自动桥接到 store: wsClient.event(topic) → store.set(topic, data) */
  bindTopic(topic, transform = (d) => d) {
    if (this.wsUnsubs.has(topic)) return;
    const unsub = wsClient.subscribe(topic, (data) => {
      this.set(topic, transform(data, this.state[topic]));
    });
    this.wsUnsubs.set(topic, unsub);
  }

  bindTopics(topics) { for (const t of topics) this.bindTopic(t); }

  get(key) { return this.state[key]; }

  set(key, value) {
    this.state[key] = value;
    const set = this.listeners.get(key);
    if (set) for (const h of set) {
      try { h(value); } catch (e) { console.error('[store] listener error', key, e); }
    }
  }

  /** 订阅变更，返回 unsubscribe。若已有值，立即回调一次。 */
  subscribe(key, handler) {
    let set = this.listeners.get(key);
    if (!set) { set = new Set(); this.listeners.set(key, set); }
    set.add(handler);
    if (key in this.state) {
      try { handler(this.state[key]); } catch (e) { console.error('[store] handler initial error', key, e); }
    }
    return () => {
      set.delete(handler);
      if (set.size === 0) this.listeners.delete(key);
    };
  }
}

export const store = new Store();
if (typeof window !== 'undefined') window.__store = store;
