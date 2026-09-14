'use strict';

const {
  getHelperStatus,
  enqueueLogin,
  findActiveRequest
} = require('./login-request-store');

function sanitizeAccount(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const safe = raw.replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 80);
  return safe || null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const account = sanitizeAccount(process.argv[2]);
  if (!account) throw new Error('account required');

  const helper = getHelperStatus();
  if (!helper.online) {
    console.error('LOGIN_HELPER_ERROR: 桌面 Login Helper 未运行。请在当前 Windows 桌面执行 npm run comment-login-helper');
    process.exitCode = 2;
    return;
  }

  const request = enqueueLogin(account);
  console.log(`[LoginRequest] 已发送到桌面 Helper：${account} | request=${request.id}`);

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await sleep(250);
    const current = findActiveRequest(account);
    if (!current || current.id !== request.id) continue;
    if (current.status === 'OPENED') {
      console.log(`[LoginRequest] 登录窗口已打开：${account}`);
      await sleep(1500);
      return;
    }
    if (current.status === 'FAILED') {
      console.error(`LOGIN_HELPER_ERROR: ${current.message || '登录窗口启动失败'}`);
      process.exitCode = 3;
      return;
    }
  }

  console.log(`[LoginRequest] 请求已提交，桌面 Helper 正在处理中：${account}`);
  await sleep(1500);
}

main().catch(error => {
  console.error(`LOGIN_HELPER_ERROR: ${error?.message || error}`);
  process.exitCode = 1;
});
