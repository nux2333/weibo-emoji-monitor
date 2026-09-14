(() => {
  const tokenEl = byId('token');
  const workerId = 'default';
  let taskLoops = 1;
  let taskInterval = 0;
  const confirmDrafts = {};

  tokenEl.value = sessionStorage.getItem('caToken') || '';

  function log(message) {
    const el = byId('log');
    el.textContent += `[${new Date().toLocaleTimeString()}] ${message}\n`;
    el.scrollTop = el.scrollHeight;
  }

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

  async function copyText(text) {
    const value = String(text || '');
    if (!value) return false;

    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (_) {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();

      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (_) {}

      document.body.removeChild(textarea);
      return ok;
    }
  }

  function initCollapse(buttonId, panelId, storageKey) {
    const button = byId(buttonId);
    const panel = byId(panelId);
    if (!button || !panel) return;

    function apply(collapsed) {
      panel.classList.toggle('collapsed', collapsed);
      button.textContent = collapsed ? '展开 ▼' : '收起 ▲';
    }

    apply(localStorage.getItem(storageKey) === '1');
    button.addEventListener('click', () => {
      const collapsed = !panel.classList.contains('collapsed');
      apply(collapsed);
      localStorage.setItem(storageKey, collapsed ? '1' : '0');
    });
  }

  function selectedAccounts() {
    return Array.from(document.querySelectorAll('.acct:checked')).map(item => item.value);
  }

  async function loadAccounts() {
    const list = await api('/api/accounts');
    byId('accountCount').textContent = String(list.length);
    byId('selectAllAccounts').checked = false;

    const body = byId('accounts');
    body.innerHTML = '';
    if (!list.length) {
      body.innerHTML = '<tr><td colspan="6" class="muted">暂无账号</td></tr>';
      return;
    }

    list.forEach((item, index) => {
      const row = document.createElement('tr');

      const checkTd = document.createElement('td');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'acct';
      checkbox.value = item.name;
      checkTd.appendChild(checkbox);

      const noTd = document.createElement('td');
      noTd.textContent = String(index + 1);

      const idTd = document.createElement('td');
      idTd.textContent = item.uid || '-';

      const usernameTd = document.createElement('td');
      usernameTd.textContent = item.name || '-';

      const loginTd = document.createElement('td');
      const login = document.createElement('span');
      login.className = item.initialized ? 'login-ok' : 'login-relogin';
      login.textContent = item.initialized ? '● 已登录' : '● 需重新登录';
      loginTd.appendChild(login);

      const actionTd = document.createElement('td');
      const relogin = document.createElement('button');
      relogin.type = 'button';
      relogin.className = 'relogin-btn relogin-account';
      relogin.dataset.account = item.name;
      relogin.textContent = '再次登录';
      actionTd.appendChild(relogin);

      if (item.name !== 'default') {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'delete-account-btn delete-account';
        del.dataset.account = item.name;
        del.textContent = '删除用户';
        actionTd.appendChild(del);
      }

      row.append(checkTd, noTd, idTd, usernameTd, loginTd, actionTd);
      body.appendChild(row);
    });
  }

  async function loadAvailableTasks() {
    const list = await api('/api/available-tasks');
    const body = byId('availableTasks');
    body.innerHTML = '';

    if (!list.length) {
      body.innerHTML = '<tr><td colspan="3" class="muted">暂无可领取任务</td></tr>';
      return;
    }

    list.forEach(item => {
      const row = document.createElement('tr');
      if (item.kind === 'builtin') row.className = 'builtin-task';

      const name = document.createElement('td');
      name.textContent = item.name || item.task_id;

      const note = document.createElement('td');
      note.textContent = item.note || '-';

      const action = document.createElement('td');
      if (item.kind === 'builtin') {
        const settings = document.createElement('div');
        settings.className = 'task-settings';

        const loopSetting = document.createElement('label');
        loopSetting.className = 'task-setting';
        loopSetting.innerHTML = '<span>循环回数</span>';
        const loopInput = document.createElement('input');
        loopInput.type = 'number';
        loopInput.min = '1';
        loopInput.max = '20';
        loopInput.value = String(taskLoops);
        loopInput.className = 'task-loops';
        loopSetting.appendChild(loopInput);

        const intervalSetting = document.createElement('label');
        intervalSetting.className = 'task-setting';
        intervalSetting.innerHTML = '<span>轮次间隔（分钟）</span>';
        const intervalInput = document.createElement('input');
        intervalInput.type = 'number';
        intervalInput.min = '0';
        intervalInput.max = '1440';
        intervalInput.value = String(taskInterval);
        intervalInput.className = 'task-interval';
        intervalSetting.appendChild(intervalInput);

        settings.append(loopSetting, intervalSetting);
        action.appendChild(settings);
      }

      const button = document.createElement('button');
      button.className = 'task-claim claim-task';
      button.type = 'button';
      button.dataset.taskId = item.task_id;
      button.textContent = '领取任务';
      action.appendChild(button);

      row.append(name, note, action);
      body.appendChild(row);
    });
  }

  function taskActionButton(account, action, text, className) {
    const button = document.createElement('button');
    button.className = `task-action ${className}`;
    button.type = 'button';
    button.textContent = text;
    button.dataset.account = account;
    button.dataset.action = action;
    return button;
  }

  async function loadTasks() {
    const list = await api('/api/my-tasks');
    const body = byId('tasks');
    body.innerHTML = '';

    if (!list.length) {
      body.innerHTML = '<tr><td colspan="5" class="muted">暂无任务</td></tr>';
      return;
    }

    list.forEach(item => {
      const row = document.createElement('tr');
      const hasRunning = Number(item.running_count || 0) > 0;

      const account = document.createElement('td');
      account.textContent = item.account || '-';

      const taskName = document.createElement('td');
      taskName.textContent = item.task_name || '-';

      const progress = document.createElement('td');
      progress.textContent = `${hasRunning ? '待处理 · ' : ''}${item.progress_count || 0}/${item.target_count || 20}`;

      const confirmTd = document.createElement('td');
      if (hasRunning) {
        const wrap = document.createElement('div');
        wrap.className = 'confirm-wrap';

        const input = document.createElement('input');
        input.type = 'text';
        input.inputMode = 'text';
        input.autocomplete = 'off';
        input.maxLength = 1;
        input.placeholder = 'y';
        input.className = 'confirm-input';
        input.dataset.account = item.account;
        input.value = confirmDrafts[item.account] || '';

        const confirmButton = document.createElement('button');
        confirmButton.type = 'button';
        confirmButton.className = 'confirm-next';
        confirmButton.dataset.account = item.account;
        confirmButton.textContent = '确认';

        wrap.append(input, confirmButton);
        confirmTd.appendChild(wrap);
      } else {
        confirmTd.textContent = '-';
      }

      const actions = document.createElement('td');
      if (hasRunning) {
        const openButton = document.createElement('button');
        openButton.type = 'button';
        openButton.className = 'open-current';
        openButton.dataset.account = item.account;
        openButton.textContent = '打开帖子';
        actions.appendChild(openButton);
        actions.appendChild(taskActionButton(item.account, 'interrupt', '中断', 'gray'));
      } else {
        actions.appendChild(taskActionButton(item.account, 'delete', '删除', 'red'));
      }

      row.append(account, taskName, progress, confirmTd, actions);
      body.appendChild(row);
    });
  }

  async function confirmNext(account, input, button) {
    const value = String(input?.value || '').trim().toLowerCase();
    if (value !== 'y') {
      alert('请输入 y 确认当前任务');
      input?.focus();
      return;
    }

    if (button) button.disabled = true;
    if (input) input.disabled = true;

    try {
      const data = await api(`/api/my-tasks/${encodeURIComponent(account)}/confirm-next`, {
        method: 'POST',
        body: JSON.stringify({ worker: workerId, confirm: 'y' })
      });

      confirmDrafts[account] = '';
      log(`账号 ${account} → y确认完成1条 | 已完成=${data.done_count} | 剩余=${data.remaining_count} | Link=${data.post_link || '-'}`);
      await loadTasks();

      const next = document.querySelector(`.confirm-input[data-account="${CSS.escape(account)}"]`);
      next?.focus();
    } catch (error) {
      alert(error.message);
      log(`确认任务失败：${error.message}`);
      if (input) {
        input.disabled = false;
        input.focus();
      }
      if (button) button.disabled = false;
    }
  }

  async function heartbeat() {
    try {
      await api('/api/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ worker: workerId, status: 'online' })
      });
    } catch (_) {}
  }

  async function connect() {
    sessionStorage.setItem('caToken', tokenEl.value.trim());
    try {
      const health = await api('/api/health');
      byId('health').innerHTML = `<span class="ok">● 已连接</span> | Host=${esc(health.host)} | Accounts=${health.accounts}`;
      await loadAccounts();
      await loadAvailableTasks();
      await loadTasks();
      await heartbeat();
      log('连接成功');
    } catch (error) {
      byId('health').innerHTML = `<span class="bad">${esc(error.message)}</span>`;
      log(`连接失败：${error.message}`);
    }
  }

  byId('connect').addEventListener('click', connect);

  byId('add').addEventListener('click', async () => {
    const name = prompt('新微博账号名称');
    if (!name) return;

    try {
      const account = await api('/api/accounts', {
        method: 'POST',
        body: JSON.stringify({ name })
      });
      log(`已创建账号目录：${account.name}`);
      await loadAccounts();
      alert('账号目录已创建。可以直接点击该账号后的“再次登录”打开 Chromium 登录。');
    } catch (error) {
      alert(error.message);
    }
  });

  byId('selectAllAccounts').addEventListener('change', function () {
    document.querySelectorAll('.acct').forEach(item => {
      item.checked = this.checked;
    });
  });

  byId('accounts').addEventListener('change', () => {
    const all = document.querySelectorAll('.acct');
    const selected = document.querySelectorAll('.acct:checked');
    byId('selectAllAccounts').checked = all.length > 0 && all.length === selected.length;
  });

  byId('accounts').addEventListener('click', async event => {
    const deleteButton = event.target.closest('.delete-account');
    if (deleteButton) {
      const accountName = deleteButton.dataset.account;
      if (!confirm(`确定删除用户 ${accountName} 吗？这会删除本地登录 Profile，并清理该账号的任务分配和历史记录。`)) return;

      deleteButton.disabled = true;
      try {
        const result = await api(`/api/accounts/${encodeURIComponent(accountName)}`, { method: 'DELETE' });
        log(`已删除用户 ${result.account}，清理任务=${result.released_tasks}`);
        await loadAccounts();
        await loadTasks();
      } catch (error) {
        alert(error.message);
        log(`删除用户失败：${error.message}`);
      }
      return;
    }

    const button = event.target.closest('.relogin-account');
    if (!button) return;

    button.disabled = true;
    const oldText = button.textContent;
    button.textContent = '正在打开...';
    try {
      const data = await api(`/api/accounts/${encodeURIComponent(button.dataset.account)}/login`, {
        method: 'POST',
        body: '{}'
      });
      log(`已打开 ${data.account} 的 Chromium 登录窗口`);
      setTimeout(() => loadAccounts().catch(() => {}), 3000);
    } catch (error) {
      alert(error.message);
      log(`打开登录窗口失败：${error.message}`);
    } finally {
      button.disabled = false;
      button.textContent = oldText;
    }
  });

  byId('availableTasks').addEventListener('input', event => {
    if (event.target.classList.contains('task-loops')) {
      taskLoops = Math.max(1, Math.min(Number(event.target.value || 1), 20));
      taskInterval = taskLoops <= 1 ? 0 : 20;
      const interval = event.target.closest('td').querySelector('.task-interval');
      if (interval) interval.value = String(taskInterval);
    } else if (event.target.classList.contains('task-interval')) {
      taskInterval = Math.max(0, Math.min(Number(event.target.value || 0), 1440));
    }
  });

  byId('availableTasks').addEventListener('click', async event => {
    const button = event.target.closest('.claim-task');
    if (!button) return;

    const accounts = selectedAccounts();
    const row = button.closest('tr');
    const loopInput = row?.querySelector('.task-loops');
    const intervalInput = row?.querySelector('.task-interval');
    const loops = loopInput ? Math.max(1, Math.min(Number(loopInput.value || 1), 20)) : 1;
    const intervalMinutes = intervalInput
      ? Math.max(0, Math.min(Number(intervalInput.value || 0), 1440))
      : 0;

    if (!accounts.length) {
      alert('请先在“当前可执行账号”里选择至少一个账号');
      return;
    }

    button.disabled = true;
    const oldText = button.textContent;
    button.textContent = '领取中...';
    try {
      const data = await api(`/api/tasks/${encodeURIComponent(button.dataset.taskId)}/claim`, {
        method: 'POST',
        body: JSON.stringify({ worker: workerId, accounts, loops })
      });
      log(`任务 ${button.dataset.taskId} 领取 ${data.count} 条 | 账号=${accounts.join(',')} | Loop=${loops} | 间隔=${intervalMinutes}分钟`);
      await loadAvailableTasks();
      await loadTasks();
    } catch (error) {
      alert(error.message);
      log(`领取任务失败：${error.message}`);
    } finally {
      button.disabled = false;
      button.textContent = oldText;
    }
  });

  byId('tasks').addEventListener('input', event => {
    if (event.target.classList.contains('confirm-input')) {
      confirmDrafts[event.target.dataset.account] = event.target.value;
    }
  });

  byId('tasks').addEventListener('keydown', event => {
    if (!event.target.classList.contains('confirm-input') || event.key !== 'Enter') return;
    event.preventDefault();
    const account = event.target.dataset.account;
    const button = event.target.closest('td').querySelector('.confirm-next');
    confirmNext(account, event.target, button);
  });

  byId('tasks').addEventListener('click', async event => {
    const openButton = event.target.closest('.open-current');
    if (openButton) {
      const accountName = openButton.dataset.account;
      openButton.disabled = true;
      const oldText = openButton.textContent;
      openButton.textContent = '打开中...';

      try {
        const current = await api(`/api/my-tasks/${encodeURIComponent(accountName)}/open-current`, {
          method: 'POST',
          body: JSON.stringify({ worker: workerId })
        });
        const copied = await copyText(current.post_text || '');
        log(`账号 ${accountName} → 已打开当前帖子 | Link=${current.post_link || '-'} | 评论文案${copied ? '已复制' : '复制失败'}`);
        if (!copied && current.post_text) {
          alert('帖子已打开，但浏览器未允许自动复制。请手动复制评论文案。');
        }
      } catch (error) {
        alert(error.message);
        log(`打开当前帖子失败：${error.message}`);
      } finally {
        openButton.disabled = false;
        openButton.textContent = oldText;
      }
      return;
    }

    const confirmButton = event.target.closest('.confirm-next');
    if (confirmButton) {
      const confirmInput = confirmButton.closest('td').querySelector('.confirm-input');
      await confirmNext(confirmButton.dataset.account, confirmInput, confirmButton);
      return;
    }

    const button = event.target.closest('.task-action');
    if (!button) return;

    const { action, account } = button.dataset;
    if (action === 'delete' && !confirm(`确定删除 ${account} 的任务记录？未完成任务会释放回任务池。`)) return;
    if (action === 'interrupt' && !confirm(`确定中断 ${account} 当前任务？`)) return;

    button.disabled = true;
    try {
      await api(`/api/my-tasks/${encodeURIComponent(account)}/action`, {
        method: 'POST',
        body: JSON.stringify({ worker: workerId, action })
      });
      log(`账号 ${account} → ${action}`);
      await loadTasks();
    } catch (error) {
      alert(error.message);
      log(`任务操作失败：${error.message}`);
    } finally {
      button.disabled = false;
    }
  });

  byId('interruptAll').addEventListener('click', async function () {
    try {
      const list = await api('/api/my-tasks');
      const running = list.filter(item => Number(item.running_count || 0) > 0);
      if (!running.length) {
        alert('当前没有执行中的任务');
        return;
      }
      if (!confirm(`确定中断全部正在执行的任务？共 ${running.length} 个账号。`)) return;

      this.disabled = true;
      this.textContent = '中断中...';
      let ok = 0;
      let failed = 0;

      for (const item of running) {
        try {
          await api(`/api/my-tasks/${encodeURIComponent(item.account)}/action`, {
            method: 'POST',
            body: JSON.stringify({ worker: workerId, action: 'interrupt' })
          });
          ok += 1;
        } catch (error) {
          failed += 1;
          log(`中断 ${item.account} 失败：${error.message}`);
        }
      }

      log(`中断全部任务完成：成功=${ok}，失败=${failed}`);
      await loadTasks();
      if (failed) alert(`已中断 ${ok} 个账号，失败 ${failed} 个，请查看 Log`);
    } catch (error) {
      alert(error.message);
      log(`中断全部任务失败：${error.message}`);
    } finally {
      this.disabled = false;
      this.textContent = '中断全部任务';
    }
  });

  initCollapse('toggleAccounts', 'accountPanel', 'caAccountsCollapsed');
  initCollapse('toggleAvailableTasks', 'availableTasksPanel', 'caAvailableTasksCollapsed');
  initCollapse('toggleResults', 'resultsPanel', 'caResultsCollapsed');
  initCollapse('toggleLog', 'logPanel', 'caLogCollapsed');

  if (tokenEl.value) connect();
  setInterval(() => {
    if (!tokenEl.value) return;
    heartbeat();
    loadAvailableTasks().catch(() => {});
    loadTasks().catch(() => {});
  }, 15000);
})();
