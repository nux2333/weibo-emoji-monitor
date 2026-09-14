'use strict';

const path = require('path');
const { spawn } = require('child_process');
const {
  setHelperHeartbeat,
  listPending,
  updateRequest,
  findActiveRequest
} = require('./login-request-store');

const ROOT = path.join(__dirname, '..', '..');
const WINDOW_SCRIPT = path.join(__dirname, 'account-login-window.js');
const running = new Map();

function friendlyError(text) {
  const source = String(text || '');
  if (/ProcessSingleton|profile directory.*already in use|Lock file can not be created/i.test(source)) {
    return '该账号的 Chromium Profile 正在被其他进程使用，请先关闭该账号浏览器或中断当前任务。';
  }
  const line = source.split(/\r?\n/).map(x => x.trim()).find(Boolean);
  return line ? line.slice(0, 300) : '登录窗口启动失败';
}

function launchRequest(request) {
  const account = String(request.account || '').trim();
  if (!account || running.has(account)) return;

  const existing = findActiveRequest(account);
  if (existing && existing.id !== request.id && ['STARTING', 'OPENED'].includes(existing.status)) {
    updateRequest(request.id, { status: 'FAILED', message: '该账号已有登录窗口正在运行' });
    return;
  }

  updateRequest(request.id, { status: 'STARTING', message: '正在打开桌面 Chromium' });
  const child = spawn(process.execPath, [WINDOW_SCRIPT, account], {
    cwd: ROOT,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
    env: { ...process.env, NODE_OPTIONS: '' }
  });

  running.set(account, child);
  let stderrText = '';
  let opened = false;

  child.stdout?.on('data', chunk => {
    const text = String(chunk || '').trimEnd();
    if (text) console.log(`[LoginHelper:${account}] ${text}`);
  });
  child.stderr?.on('data', chunk => {
    const text = String(chunk || '');
    stderrText += text;
    if (text.trim()) console.warn(`[LoginHelper:${account}] ${text.trimEnd()}`);
  });

  const openedTimer = setTimeout(() => {
    if (child.exitCode !== null || child.killed) return;
    opened = true;
    updateRequest(request.id, { status: 'OPENED', message: '登录窗口已打开' });
    console.log(`[LoginHelper] 已打开 ${account} | pid=${child.pid}`);
  }, 1200);

  child.on('error', error => {
    clearTimeout(openedTimer);
    running.delete(account);
    updateRequest(request.id, { status: 'FAILED', message: friendlyError(error?.message) });
  });

  child.on('exit', (code, signal) => {
    clearTimeout(openedTimer);
    running.delete(account);
    if (!opened || Number(code || 0) !== 0) {
      updateRequest(request.id, {
        status: 'FAILED',
        message: friendlyError(stderrText || `登录窗口退出 code=${code ?? '-'} signal=${signal || '-'}`)
      });
    } else {
      updateRequest(request.id, { status: 'CLOSED', message: '登录窗口已关闭' });
    }
    console.log(`[LoginHelper] ${account} 结束 | code=${code ?? '-'} | signal=${signal || '-'}`);
  });
}

function tick() {
  try {
    setHelperHeartbeat({
      running_accounts: Array.from(running.keys()),
      status: 'online'
    });
    for (const request of listPending()) launchRequest(request);
  } catch (error) {
    console.error(`[LoginHelper] ${error?.stack || error}`);
  }
}

console.log('==============================================');
console.log('Comment Assistant Desktop Login Helper');
console.log('请保持此窗口运行；网页“再次登录”会在当前桌面打开 Chromium。');
console.log('==============================================');

tick();
setInterval(tick, 1000);
