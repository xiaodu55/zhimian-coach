const routes = new Map();

export function registerRoute(name, renderFn) {
  routes.set(name, renderFn);
}

export function navigate(path) {
  window.location.hash = path.startsWith('#') ? path : `#${path}`;
}

export function getCurrentRoute() {
  const raw = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  return routes.has(raw) ? raw : 'bank';
}

export function initRouter() {
  const render = () => {
    const routeName = getCurrentRoute();
    document.querySelectorAll('.nav-link').forEach((el) => {
      el.classList.toggle('active', el.dataset.route === routeName);
    });
    const root = document.getElementById('screen-root');
    const fn = routes.get(routeName);
    if (root && fn) {
      root.innerHTML = '';
      // 屏幕模块是按需动态加载的（首屏只要 app.js + 当前屏两个请求），
      // 所以渲染函数可能是异步的：这里必须 await，否则会渲染到已被清空的容器。
      Promise.resolve(fn(root)).catch((err) => {
        console.error('[router] 界面渲染失败：', err);
        if (root) {
          root.innerHTML =
            '<div style="padding:24px;color:#b91c1c;font-size:14px">' +
            '这个界面加载失败了，请刷新重试。' +
            '</div>';
        }
      });
    }
  };
  window.addEventListener('hashchange', render);
  render();
}
