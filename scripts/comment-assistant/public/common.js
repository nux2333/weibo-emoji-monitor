function byId(id) {
  return document.getElementById(id);
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function showFatal(message) {
  const el = byId('fatal');
  if (!el) return;
  el.style.display = 'block';
  el.textContent = `页面脚本错误：${message}`;
}

window.addEventListener('error', event => {
  showFatal(event.message || 'unknown error');
});

window.addEventListener('unhandledrejection', event => {
  showFatal((event.reason && event.reason.message) || String(event.reason || 'Promise error'));
});
