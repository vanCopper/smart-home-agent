// public/js/core/ws-client.js
// ────────────────────────────────────────────────────────────────
// Topic 订阅式 WebSocket 客户端
//
//   import { wsClient } from './ws-client.js';
//   wsClient.subscribe('env/indoor', data => { ... });   // -> unsubscribe 函数
//   wsClient.rpc('devices.toggle', { id:'ac_living' });  // -> Promise<result>
//
// 特性：
//   - 页面加载立刻连接；断线指数退避重连 (1s → 10s)
//   - 多 handler 订阅同一 topic，只向服务器发送一次 subscribe
//   - 重连后自动重新订阅所有 topic
//   - 发送队列：连接未建立时的消息缓存起来，连上后冲刷
// ────────────────────────────────────────────────────────────────

class WSClient extends EventTarget {
  constructor() {
    super();
    this.url = this._resolveUrl();
    /** @type {WebSocket|null} */
    this.ws = null;
    this.connected = false;
    this.reconnectDelay = 1000;
    this.queue = [];
    /** topic -> Set<handler> */
    this.handlers = new Map();
    /** rpc id -> { resolve, reject, timer } */
    this.rpcPending = new Map();
    this.rpcSeq = 0;

    this._connect();

    // 页面可见时立即探测一次，避免 iPad 睡眠后状态停留
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !this.connected) this._connect();
    });
  }

  _resolveUrl() {
    const loc = window.location;
    const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${loc.host}/ws`;
  }

  _connect() {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;
    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      console.warn('[ws] failed to open', e);
      this._scheduleReconnect();
      return;
    }

    this.ws.addEventListener('open', () => {
      this.connected = true;
      this.reconnectDelay = 1000;
      this.dispatchEvent(new CustomEvent('open'));
      console.log('[ws] open', this.url);

      // 重新订阅所有现有 topic
      const topics = Array.from(this.handlers.keys());
      if (topics.length) this._send({ type:'subscribe', topics });

      // 冲刷队列
      while (this.queue.length) this._send(this.queue.shift());
    });

    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'event' && msg.topic) {
        const handlers = this.handlers.get(msg.topic);
        if (handlers) for (const h of handlers) {
          try { h(msg.data, msg); } catch (e) { console.error('[ws] handler error', msg.topic, e); }
        }
      } else if (msg.type === 'rpc_result') {
        const pending = this.rpcPending.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.rpcPending.delete(msg.id);
          if (msg.ok) pending.resolve(msg.data ?? msg);
          else pending.reject(new Error(msg.error || 'rpc failed'));
        }
      } else if (msg.type === 'hello') {
        console.log('[ws] hello', msg.server);
      }
    });

    this.ws.addEventListener('close', () => {
      this.connected = false;
      this.dispatchEvent(new CustomEvent('close'));
      this._scheduleReconnect();
    });

    this.ws.addEventListener('error', () => {
      // 'error' 通常也会触发 close —— 交给 close 处理
    });
  }

  _scheduleReconnect() {
    setTimeout(() => this._connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.6, 10_000);
  }

  _send(msg) {
    if (this.connected && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.queue.push(msg);
    }
  }

  /**
   * 订阅一个 topic。返回 unsubscribe 函数。
   * @param {string} topic
   * @param {(data:any, msg:any)=>void} handler
   */
  subscribe(topic, handler) {
    let set = this.handlers.get(topic);
    const first = !set;
    if (!set) { set = new Set(); this.handlers.set(topic, set); }
    set.add(handler);
    if (first) this._send({ type:'subscribe', topics:[topic] });
    return () => this.unsubscribe(topic, handler);
  }

  unsubscribe(topic, handler) {
    const set = this.handlers.get(topic);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) {
      this.handlers.delete(topic);
      this._send({ type:'unsubscribe', topics:[topic] });
    }
  }

  /**
   * 调用一个服务端 RPC 方法。
   * @param {string} method
   * @param {object} params
   * @returns {Promise<any>}
   */
  rpc(method, params = {}, timeoutMs = 5000) {
    const id = `r${++this.rpcSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rpcPending.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }, timeoutMs);
      this.rpcPending.set(id, { resolve, reject, timer });
      this._send({ type:'rpc', id, method, params });
    });
  }
}

export const wsClient = new WSClient();
// 方便 devtools debug
if (typeof window !== 'undefined') window.__ws = wsClient;
