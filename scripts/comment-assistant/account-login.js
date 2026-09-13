'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const PROFILE_ROOT = path.join(ROOT, 'data', 'comment-assistant-profiles');
const LEGACY_PROFILE_DIR = path.join(ROOT, 'data', 'comment-assistant-profile');

function sanitizeAccount(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return safe || null;
}

async function main() {
  const account = sanitizeAccount(process.argv[2]);
  if (!account) throw new Error('account required');

  const profileDir = account === 'default'
    ? LEGACY_PROFILE_DIR
    : path.join(PROFILE_ROOT, account);

  if (!fs.existsSync(profileDir)) {
    throw new Error(`账号 Profile 不存在：${account}`);
  }

  console.log(`[Comment Assistant Login] 打开账号：${account}`);
  console.log(`[Comment Assistant Login] Profile：${profileDir}`);

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 900 }
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://weibo.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  }).catch(() => null);

  console.log('[Comment Assistant Login] 请在打开的 Chromium 中完成扫码/重新登录。完成后直接关闭浏览器即可。');

  await new Promise(resolve => context.once('close', resolve));
  console.log(`[Comment Assistant Login] 浏览器已关闭：${account}`);
}

main().catch(error => {
  console.error('[Comment Assistant Login] 失败：', error?.stack || error);
  process.exitCode = 1;
});
