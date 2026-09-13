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
  // 保留 Unicode 字母/数字（包括中文、日文等），只替换不适合作为目录名的字符。
  const safe = raw.replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 80);
  return safe || null;
}

function saveMeta(profileDir, meta) {
  if (!meta || (!meta.uid && !meta.username)) return false;
  const file = path.join(profileDir, 'account-meta.json');
  const payload = {
    uid: meta.uid ? String(meta.uid) : null,
    username: meta.username ? String(meta.username).trim() : null,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return true;
}

async function detectAccountMeta(page) {
  try {
    return await page.evaluate(() => {
      const cfg = window.$CONFIG || window.__INITIAL_STATE__ || {};
      const pick = (...values) => values.find(v => v !== undefined && v !== null && String(v).trim()) || null;

      let uid = pick(
        cfg.uid,
        cfg.user?.id,
        cfg.user?.idstr,
        cfg.login_user?.id,
        cfg.login_user?.idstr
      );
      let username = pick(
        cfg.nick,
        cfg.nickname,
        cfg.user?.screen_name,
        cfg.user?.name,
        cfg.login_user?.screen_name,
        cfg.login_user?.name
      );

      if (!uid) {
        const links = Array.from(document.querySelectorAll('a[href]'));
        for (const a of links) {
          const href = a.getAttribute('href') || '';
          const m = href.match(/(?:weibo\.com\/u\/|^\/u\/)(\d{5,})/);
          if (m) {
            uid = m[1];
            if (!username) {
              const text = (a.getAttribute('title') || a.textContent || '').trim();
              if (text && text.length <= 80) username = text;
            }
            break;
          }
        }
      }

      if (!username) {
        const candidates = Array.from(document.querySelectorAll('[title], a, span'));
        const node = candidates.find(el => {
          const t = (el.getAttribute?.('title') || el.textContent || '').trim();
          return t && t.length >= 2 && t.length <= 40 && /个人主页|主页/.test(el.closest?.('a')?.getAttribute?.('href') || '') === false;
        });
        if (node) username = (node.getAttribute?.('title') || node.textContent || '').trim();
      }

      return {
        uid: uid ? String(uid) : null,
        username: username ? String(username).trim() : null
      };
    });
  } catch (_) {
    return null;
  }
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

  let timer = null;
  const refreshMeta = async () => {
    const pages = context.pages();
    const current = pages[0] || page;
    const meta = await detectAccountMeta(current);
    if (saveMeta(profileDir, meta)) {
      console.log(`[Comment Assistant Login] 已保存账号信息：UID=${meta.uid || '-'} | 用户名=${meta.username || '-'}`);
    }
  };

  await refreshMeta().catch(() => null);
  timer = setInterval(() => refreshMeta().catch(() => null), 3000);

  await new Promise(resolve => context.once('close', resolve));
  if (timer) clearInterval(timer);
  console.log(`[Comment Assistant Login] 浏览器已关闭：${account}`);
}

main().catch(error => {
  console.error('[Comment Assistant Login] 失败：', error?.stack || error);
  process.exitCode = 1;
});
