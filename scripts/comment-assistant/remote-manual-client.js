'use strict';

const readline = require('readline');
const { execFile } = require('child_process');

const API_BASE = String(process.env.COMMENT_REMOTE_API_BASE || '').replace(/\/$/, '');
const TOKEN = String(process.env.COMMENT_API_TOKEN || '').trim();
const WORKER = String(process.env.COMMENT_WORKER || process.env.COMPUTERNAME || 'PC-B').trim();
const ACCOUNT = String(process.argv[2] || process.env.COMMENT_ACCOUNT || '').trim();
const LIMIT = Math.max(1, Math.min(Number(process.argv[3] || 20), 20));

if (!API_BASE) {
  console.error('请设置 COMMENT_REMOTE_API_BASE，例如 https://comment-api.example.com');
  process.exit(1);
}
if (!TOKEN) {
  console.error('请设置 COMMENT_API_TOKEN');
  process.exit(1);
}
if (!ACCOUNT) {
  console.error('用法：node remote-manual-client.js <account> [limit]');
  process.exit(1);
}

async function api(path, options = {}) {
  const response = await fetch(API_BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...(options.headers || {})
    }
  });
  let json;
  try {
    json = await response.json();
  } catch (_) {
    throw new Error(`HTTP ${response.status}`);
  }
  if (!response.ok || !json.success) throw new Error(json.message || `HTTP ${response.status}`);
  return json.data;
}

function ask(rl, text) {
  return new Promise(resolve => rl.question(text, answer => resolve(String(answer || '').trim().toLowerCase())));
}

function openUrl(url) {
  if (process.platform === 'win32') {
    execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
    return;
  }
  if (process.platform === 'darwin') {
    execFile('open', [url], () => {});
    return;
  }
  execFile('xdg-open', [url], () => {});
}

async function mark(taskId, status, result) {
  return api(`/api/tasks/${encodeURIComponent(taskId)}/result`, {
    method: 'POST',
    body: JSON.stringify({ worker: WORKER, status, result })
  });
}

async function interruptRemaining() {
  return api('/api/tasks/interrupt', {
    method: 'POST',
    body: JSON.stringify({ worker: WORKER, account: ACCOUNT })
  });
}

async function main() {
  const health = await api('/api/health');
  console.log(`[连接成功] Host=${health.host} | Worker=${WORKER} | Account=${ACCOUNT}`);

  const task = await api('/api/default-task/claim', {
    method: 'POST',
    body: JSON.stringify({ worker: WORKER, account: ACCOUNT, limit: LIMIT })
  });

  console.log(`\n任务：${task.task_name}`);
  console.log(`领取：${task.count}/${task.target_count}`);
  if (!task.items.length) {
    console.log('当前没有可领取候选。');
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let done = 0;
  let skipped = 0;

  try {
    for (let i = 0; i < task.items.length; i += 1) {
      const item = task.items[i];
      console.log('\n==============================================');
      console.log(`[${i + 1}/${task.items.length}] 已完成=${done} | 已跳过=${skipped}`);
      console.log(`账号=${ACCOUNT}`);
      console.log(`UID=${item.uid || '-'} | 用户名=${item.username || '-'}`);
      console.log(`经验值=${item.experience_7d ?? '-'} | 当前评论=${item.comments_count ?? '-'}`);
      console.log(`Post=${item.post_id}`);
      console.log(`Link=${item.post_link}`);
      if (item.post_text) console.log(`文案=${item.post_text}`);
      console.log('');
      console.log('o = 打开帖子 | y = 手动处理完成 | s = 跳过 | q = 中断');

      while (true) {
        const command = await ask(rl, '> ');
        if (command === 'o') {
          openUrl(item.post_link);
          continue;
        }
        if (command === 'y') {
          await mark(item.task_id, 'DONE', '客户端手动确认完成');
          done += 1;
          console.log(`[完成] ${done}/${task.target_count}`);
          break;
        }
        if (command === 's') {
          await mark(item.task_id, 'SKIPPED', '客户端手动跳过');
          skipped += 1;
          console.log('[跳过]');
          break;
        }
        if (command === 'q') {
          const result = await interruptRemaining();
          console.log(`[中断] 剩余 ${result.interrupted} 条已标记为中断。`);
          return;
        }
        console.log('请输入 o / y / s / q');
      }
    }
  } finally {
    rl.close();
  }

  console.log(`\n处理结束：完成=${done}，跳过=${skipped}，总数=${task.items.length}`);
}

main().catch(error => {
  console.error(`[Remote Client] ${error.message}`);
  process.exitCode = 1;
});
