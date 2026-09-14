'use strict';

const fs = require('fs');
const path = require('path');
const { chromium, request } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const LEGACY_PROFILE_DIR = path.join(ROOT, 'data', 'comment-assistant-profile');
const PROFILE_ROOT = path.join(ROOT, 'data', 'comment-assistant-profiles');
const HTTP_TIMEOUT_MS = Number(process.env.COMMENT_HTTP_TIMEOUT_MS || 15000);
const openPostContexts = new Map();

function sanitizeAccountName(value) {
  const raw = String(value || 'default').trim();
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return cleaned || 'default';
}

function accountProfileDir(accountName) {
  const account = sanitizeAccountName(accountName);
  const defaultDir = path.join(PROFILE_ROOT, account);
  if (account === 'default' && fs.existsSync(LEGACY_PROFILE_DIR) && !fs.existsSync(defaultDir)) {
    return LEGACY_PROFILE_DIR;
  }
  return defaultDir;
}

function hasProfileData(profileDir) {
  if (!fs.existsSync(profileDir)) return false;
  return [
    path.join(profileDir, 'Default', 'Network', 'Cookies'),
    path.join(profileDir, 'Default', 'Cookies'),
    path.join(profileDir, 'Local State')
  ].some(file => fs.existsSync(file));
}

async function launchProfileContext(accountName, options = {}) {
  const profileDir = accountProfileDir(accountName);
  if (!fs.existsSync(profileDir)) throw new Error(`账号 Profile 不存在：${accountName}`);
  return chromium.launchPersistentContext(profileDir, {
    headless: options.headless !== false,
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true
  });
}

async function openPostForAccount(accountName, postLink, options = {}) {
  const account = sanitizeAccountName(accountName);
  const link = String(postLink || '').trim();
  if (!link) throw new Error('postLink 不能为空');

  let context = openPostContexts.get(account);
  if (!context) {
    context = await launchProfileContext(account, {
      headless: options.headless === true
    });
    openPostContexts.set(account, context);
    context.once('close', () => {
      if (openPostContexts.get(account) === context) openPostContexts.delete(account);
    });
  }

  const pages = context.pages();
  const page = pages[0] || (await context.newPage());
  await page.goto(link, {
    waitUntil: 'domcontentloaded',
    timeout: Number(options.timeout || 30000)
  });
  await page.bringToFront().catch(() => {});

  return {
    context,
    page,
    url: page.url()
  };
}

async function hasWeiboLogin(context) {
  const cookies = await context.cookies('https://weibo.com');
  return cookies.some(cookie => cookie.name === 'SUB' && cookie.value);
}

async function collectBrowserSession(context) {
  const page = context.pages()[0] || (await context.newPage());
  let browserInfo = null;
  try {
    browserInfo = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      language: navigator.language
    }));
  } catch (_) {}

  return {
    cookies: await context.cookies(),
    userAgent:
      browserInfo?.userAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
    language: browserInfo?.language || 'zh-CN'
  };
}

async function readSessionFromProfile(accountName) {
  const context = await launchProfileContext(accountName, { headless: true });
  try {
    const loggedIn = await hasWeiboLogin(context);
    if (!loggedIn) throw new Error(`账号 ${accountName} 登录信息不存在或已失效`);
    return await collectBrowserSession(context);
  } finally {
    await context.close().catch(() => {});
  }
}

async function createHttpContext(session) {
  return request.newContext({
    ignoreHTTPSErrors: true,
    userAgent: session.userAgent,
    storageState: { cookies: session.cookies, origins: [] },
    extraHTTPHeaders: {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': session.language || 'zh-CN'
    }
  });
}

async function warmPost(api, postLink) {
  const response = await api.get(postLink, {
    timeout: HTTP_TIMEOUT_MS,
    failOnStatusCode: false,
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      Referer: 'https://weibo.com/'
    }
  });
  return {
    status: response.status(),
    url: response.url(),
    ok: response.ok()
  };
}

async function prepareReadOnlyPostSession(accountName, postLink) {
  const session = await readSessionFromProfile(accountName);
  const api = await createHttpContext(session);
  try {
    const warm = await warmPost(api, postLink);
    return {
      cookieCount: session.cookies.length,
      userAgent: session.userAgent,
      language: session.language,
      warm
    };
  } finally {
    await api.dispose().catch(() => {});
  }
}

module.exports = {
  ROOT,
  PROFILE_ROOT,
  LEGACY_PROFILE_DIR,
  sanitizeAccountName,
  accountProfileDir,
  hasProfileData,
  launchProfileContext,
  openPostForAccount,
  hasWeiboLogin,
  collectBrowserSession,
  readSessionFromProfile,
  createHttpContext,
  warmPost,
  prepareReadOnlyPostSession
};
