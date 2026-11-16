export function showToast(message, type = 'info', duration = 3200) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type === 'warn' ? 'toast-warn' : type === 'error' ? 'toast-error' : ''}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.25s';
    setTimeout(() => el.remove(), 260);
  }, duration);
}
