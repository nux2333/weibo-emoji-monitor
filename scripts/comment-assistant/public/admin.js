(() => {
  const tokenEl = byId('token');
  tokenEl.value = sessionStorage.getItem('caAdminToken') || '';

  async function api(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenEl.value.trim()}`,
        ...(options.headers || {})
      }
    });

    let json;
    try {
      json = await response.json();
    } catch (_) {
      json = { success: false, message: `HTTP ${response.status}` };
    }

    if (!response.ok || !json.success) {
      throw new Error(json.message || `HTTP ${response.status}`);
    }
    return json.data;
  }

  async function load() {
    const status = byId('status').value;
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    const list = await api(`/api/admin/tasks${query}`);
    const body = byId('tasks');
    body.innerHTML = '';

    if (!list.length) {
      body.innerHTML = '<tr><td colspan="7" class="muted">暂无任务</td></tr>';
    } else {
      list.forEach(item => {
        const row = document.createElement('tr');

        [item.status, item.priority].forEach(value => {
          const td = document.createElement('td');
          td.textContent = value == null ? '-' : String(value);
          row.appendChild(td);
        });

        const post = document.createElement('td');
        const link = document.createElement('a');
        link.target = '_blank';
        link.rel = 'noopener';
        link.href = item.post_link;
        link.textContent = '打开';
        post.appendChild(link);
        if (item.post_text) {
          post.appendChild(document.createElement('br'));
          const text = document.createElement('span');
          text.className = 'muted';
          text.textContent = item.post_text;
          post.appendChild(text);
        }
        row.appendChild(post);

        const worker = document.createElement('td');
        worker.textContent = item.worker_id || '-';
        row.appendChild(worker);

        const account = document.createElement('td');
        account.textContent = item.account || '-';
        row.appendChild(account);

        const result = document.createElement('td');
        result.textContent = item.result || '-';
        row.appendChild(result);

        const action = document.createElement('td');
        if (item.status !== 'CANCELLED' && item.status !== 'DONE') {
          const cancel = document.createElement('button');
          cancel.className = 'red cancel-task';
          cancel.textContent = '取消';
          cancel.dataset.taskId = item.task_id;
          action.appendChild(cancel);
        } else {
          action.textContent = '-';
        }
        row.appendChild(action);
        body.appendChild(row);
      });
    }

    const onlineWorkers = await api('/api/admin/workers');
    const workers = byId('workers');
    workers.innerHTML = '';

    if (!onlineWorkers.length) {
      workers.innerHTML = '<div class="muted">暂无在线 Worker</div>';
      return;
    }

    onlineWorkers.forEach(item => {
      const box = document.createElement('div');
      box.className = 'box';
      box.innerHTML = `<b>${esc(item.worker)}</b><br>账号：${esc(item.account || '-')}<br>状态：${esc(item.status || '-')}<br><span class="muted">${esc(item.lastSeenAt)}</span>`;
      workers.appendChild(box);
    });
  }

  async function connect() {
    sessionStorage.setItem('caAdminToken', tokenEl.value.trim());
    try {
      await load();
      byId('state').innerHTML = '<span class="ok">● 已连接管理员接口</span>';
    } catch (error) {
      byId('state').innerHTML = `<span class="bad">${esc(error.message)}</span>`;
    }
  }

  byId('connect').addEventListener('click', connect);
  byId('refresh').addEventListener('click', () => load().catch(error => alert(error.message)));
  byId('status').addEventListener('change', () => load().catch(error => alert(error.message)));

  byId('publish').addEventListener('click', async () => {
    try {
      await api('/api/admin/tasks', {
        method: 'POST',
        body: JSON.stringify({
          post_id: byId('postId').value,
          post_link: byId('link').value,
          post_text: byId('text').value,
          note: byId('note').value,
          priority: Number(byId('priority').value || 0)
        })
      });

      byId('link').value = '';
      byId('postId').value = '';
      byId('text').value = '';
      byId('note').value = '';
      await load();
    } catch (error) {
      alert(error.message);
    }
  });

  byId('tasks').addEventListener('click', async event => {
    const button = event.target.closest('.cancel-task');
    if (!button) return;
    if (!confirm('确定取消这个任务？')) return;

    try {
      await api(`/api/admin/tasks/${encodeURIComponent(button.dataset.taskId)}/cancel`, {
        method: 'POST',
        body: '{}'
      });
      await load();
    } catch (error) {
      alert(error.message);
    }
  });

  if (tokenEl.value) connect();
  setInterval(() => {
    if (tokenEl.value) load().catch(() => {});
  }, 15000);
})();
