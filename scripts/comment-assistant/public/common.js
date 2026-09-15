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

// Comment Assistant 用户页：每台连接 PC/浏览器生成一个稳定 workerId。
// 文案按 workerId 保存到服务器数据库，不再只依赖浏览器 localStorage。
(() => {
  if (!document.getElementById('commentCopyList')) return;

  const WORKER_KEY = 'commentAssistantWorkerId';
  const COPY_LOCAL_KEY = 'commentAssistantRandomCopiesPreview';
  const DEFAULT_COMMENT = '#田栩宁[超话]##微博星宝养成计划##微博星宝#泥嚎～交个朋友吧 ​';

  function makeWorkerId() {
    if (window.crypto?.randomUUID) return `worker-${window.crypto.randomUUID()}`;
    return `worker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  let workerId = localStorage.getItem(WORKER_KEY);
  if (!workerId || workerId === 'default') {
    workerId = makeWorkerId();
    localStorage.setItem(WORKER_KEY, workerId);
  }
  window.commentAssistantWorkerId = workerId;

  const previousFetch = window.fetch.bind(window);
  let loadingCopies = false;
  let loadedCopies = false;
  let saveTimer = null;

  function token() {
    return String(document.getElementById('token')?.value || '').trim();
  }

  function currentCopies() {
    const inputs = Array.from(document.querySelectorAll('.comment-copy-input'));
    const copies = inputs.map(input => String(input.value || '').trim()).filter(Boolean);
    return copies.length ? copies : [DEFAULT_COMMENT];
  }

  function sameCopies(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  async function loadWorkerCopies() {
    if (loadingCopies || !token()) return;
    loadingCopies = true;
    try {
      const response = await previousFetch(`/api/comment-copies?worker=${encodeURIComponent(workerId)}`, {
        headers: { Authorization: `Bearer ${token()}` }
      });
      const json = await response.json();
      if (!response.ok || !json.success) throw new Error(json.message || `HTTP ${response.status}`);

      const copies = Array.isArray(json.data?.copies) && json.data.copies.length
        ? json.data.copies.map(v => String(v || '').trim()).filter(Boolean)
        : [DEFAULT_COMMENT];
      const localCopies = String(localStorage.getItem(COPY_LOCAL_KEY) || '')
        .split(/\r?\n/).map(v => v.trim()).filter(Boolean);

      loadedCopies = true;
      if (!sameCopies(copies, localCopies.length ? localCopies : [DEFAULT_COMMENT])) {
        localStorage.setItem(COPY_LOCAL_KEY, copies.join('\n'));
        location.reload();
        return;
      }

      const health = document.getElementById('health');
      if (health && !health.textContent.includes('Worker=')) {
        health.insertAdjacentHTML('beforeend', ` | Worker=<span title="${workerId}">${esc(workerId.slice(0, 18))}…</span>`);
      }
    } catch (error) {
      console.warn(`[评论文案] 读取数据库失败：${error.message}`);
    } finally {
      loadingCopies = false;
    }
  }

  async function saveWorkerCopies() {
    if (!token()) return;
    const copies = currentCopies();
    try {
      const response = await previousFetch('/api/comment-copies', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token()}`
        },
        body: JSON.stringify({ worker: workerId, copies })
      });
      const json = await response.json();
      if (!response.ok || !json.success) throw new Error(json.message || `HTTP ${response.status}`);
      loadedCopies = true;
      console.info(`[评论文案] worker=${workerId} 已保存 ${copies.length} 条`);
    } catch (error) {
      console.warn(`[评论文案] 保存数据库失败：${error.message}`);
    }
  }

  function queueSave() {
    if (!loadedCopies) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveWorkerCopies, 350);
  }

  document.addEventListener('input', event => {
    if (event.target?.classList?.contains('comment-copy-input')) queueSave();
  });
  document.addEventListener('click', event => {
    if (event.target?.closest?.('#addCommentCopy, .comment-copy-remove')) {
      setTimeout(queueSave, 0);
    }
  });

  window.fetch = (input, init = {}) => {
    let url = typeof input === 'string' ? input : String(input?.url || '');
    let nextInput = input;
    let nextInit = { ...init };

    try {
      if (/^\/api\/my-tasks(?:\?|$)/.test(url) && String(nextInit.method || 'GET').toUpperCase() === 'GET') {
        const separator = url.includes('?') ? '&' : '?';
        url = `${url}${separator}worker=${encodeURIComponent(workerId)}`;
        nextInput = url;
      }

      if (nextInit.body && typeof nextInit.body === 'string' && /^\/api\//.test(url)) {
        const body = JSON.parse(nextInit.body);
        if (Object.prototype.hasOwnProperty.call(body, 'worker') || /\/tasks\//.test(url) || /\/heartbeat/.test(url)) {
          body.worker = workerId;
        }
        if (/^\/api\/(?:tasks\/claim|tasks\/[^/]+\/claim)(?:\?|$)/.test(url)) {
          body.comment_copies = currentCopies();
        }
        nextInit.body = JSON.stringify(body);
      }
    } catch (_) {}

    const request = previousFetch(nextInput, nextInit);
    if (/^\/api\/health(?:\?|$)/.test(url)) {
      request.then(response => {
        if (response.ok) setTimeout(loadWorkerCopies, 0);
      }).catch(() => {});
    }
    return request;
  };
})();
