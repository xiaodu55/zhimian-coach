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
      fn(root);
    }
  };
  window.addEventListener('hashchange', render);
  render();
}
