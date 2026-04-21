// public/js/core/router.js
// ────────────────────────────────────────────
// Hash router：只切换 <div data-route="x"> 的 active 状态，
// 不做远程加载——所有页面组件一开始就挂在 DOM 里，
// 这样 WS 订阅不会频繁建立/断开，切屏也无感。
// ────────────────────────────────────────────

const routes = new Map();      // name -> { el, onEnter?, onLeave? }
let currentName = null;

export function registerRoute(name, el, hooks = {}) {
  routes.set(name, { el, ...hooks });
}

export function go(name) {
  if (!routes.has(name)) {
    console.warn('[router] unknown route:', name);
    return;
  }
  if (currentName === name) return;

  if (currentName) {
    const cur = routes.get(currentName);
    cur.el.classList.remove('active');
    cur.onLeave?.();
  }

  const next = routes.get(name);
  next.el.classList.add('active');
  next.onEnter?.();
  currentName = name;

  const hash = `#/${name === 'hub' ? '' : name}`;
  if (window.location.hash !== hash) {
    history.replaceState(null, '', hash);
  }
}

export function start(defaultRoute = 'hub') {
  const resolve = () => {
    const raw = window.location.hash.replace(/^#\/?/, '').trim();
    const name = raw || defaultRoute;
    go(routes.has(name) ? name : defaultRoute);
  };
  window.addEventListener('hashchange', resolve);
  resolve();
}

export function currentRoute() { return currentName; }
