'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const { chromium, request } = require('playwright');
const { db, initDatabase } = require('../../src/db');

const ROOT = path.join(__dirname, '..', '..');
function sanitizeAccountName(value) {
  const raw = String(value || 'default').trim();
  const cleaned = raw.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '').trim();
  return cleaned || 'default';
}

const ACCOUNT = sanitizeAccountName(process.env.COMMENT_ACCOUNT || 'default');
const LEGACY_PROFILE_DIR = path.join(ROOT, 'data', 'comment-assistant-profile');
const PROFILE_ROOT = path.join(ROOT, 'data', 'comment-assistant-profiles');
const DEFAULT_ACCOUNT_PROFILE = path.join(PROFILE_ROOT, ACCOUNT);
const PROFILE_DIR = process.env.COMMENT_ASSISTANT_PROFILE
  ? path.resolve(process.env.COMMENT_ASSISTANT_PROFILE)
  : (ACCOUNT === 'default' && fs.existsSync(LEGACY_PROFILE_DIR) && !fs.existsSync(DEFAULT_ACCOUNT_PROFILE)
      ? LEGACY_PROFILE_DIR : DEFAULT_ACCOUNT_PROFILE);
const GOOD_PROXY_FILE = process.env.WEIBO_GOOD_PROXY_FILE
  ? path.resolve(process.env.WEIBO_GOOD_PROXY_FILE)
  : path.join(ROOT, 'data', 'weibo-good-proxies.txt');
const MIN_EXPERIENCE = Number(process.env.COMMENT_MIN_EXPERIENCE || 70);
const LIMIT = Number(process.env.COMMENT_TARGET_LIMIT || 20);
const MAX_COMMENTS = Number(process.env.COMMENT_MAX_EXISTING_COMMENTS || 19);
const DEFAULT_COMMENT = process.env.COMMENT_TEXT || '法国人是世界上最严肃的人类因为他们见面就会互相说一句绷住';
const COMMENT_FP = process.env.COMMENT_FP || '';
const COMMENT_BROWSER_PROXY = String(process.env.COMMENT_BROWSER_PROXY || '').trim();
const HTTP_TIMEOUT_MS = Number(process.env.COMMENT_HTTP_TIMEOUT_MS || 15000);
let ACCOUNT_PROXY = null;

fs.mkdirSync(PROFILE_DIR, { recursive: true });

function formatShanghaiDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}
function getShanghaiToday() { return formatShanghaiDate(new Date()); }
function normalizeProxy(rawValue) {
  const raw = String(rawValue || '').split('#')[0].trim();
  if (!raw) return null;
  return /^(?:https?|socks5):\/\//i.test(raw) ? raw : `http://${raw}`;
}
function readGoodProxyPool() {
  try {
    if (!fs.existsSync(GOOD_PROXY_FILE)) return [];
    return Array.from(new Set(fs.readFileSync(GOOD_PROXY_FILE, 'utf8').split(/\r?\n/).map(normalizeProxy).filter(Boolean)));
  } catch (error) {
    console.warn(`[代理池] 读取失败：${error.message}`);
    return [];
  }
}
function toPlaywrightProxy(rawValue) {
  const normalized = normalizeProxy(rawValue);
  if (!normalized) return null;
  try {
    const p = new URL(normalized);
    const proxy = { server: `${p.protocol}//${p.hostname}${p.port ? ':' + p.port : ''}` };
    if (p.username) proxy.username = decodeURIComponent(p.username);
    if (p.password) proxy.password = decodeURIComponent(p.password);
    return proxy;
  } catch { return { server: normalized }; }
}
function maskProxy(rawValue) {
  try {
    const p = new URL(rawValue);
    return `${p.protocol}//${p.hostname}${p.port ? ':' + p.port : ''}`;
  } catch { return String(rawValue || '').replace(/\/\/[^@]+@/, '//***@'); }
}
function initializeAccountProxy() {
  if (ACCOUNT_PROXY) return ACCOUNT_PROXY;
  const override = normalizeProxy(COMMENT_BROWSER_PROXY);
  if (override) {
    ACCOUNT_PROXY = override;
    console.log(`[账号代理] 使用固定代理：${maskProxy(ACCOUNT_PROXY)}`);
    return ACCOUNT_PROXY;
  }
  const pool = readGoodProxyPool();
  if (!pool.length) {
    console.warn('[账号代理] 健康代理池为空，本次尝试直连。');
    return null;
  }
  ACCOUNT_PROXY = pool[Math.floor(Math.random() * pool.length)];
  console.log(`[账号代理] 本次固定：${maskProxy(ACCOUNT_PROXY)}`);
  return ACCOUNT_PROXY;
}

function getTargets() {
  const today = getShanghaiToday();
  const rows = db.prepare(`SELECT post_id, uid, username, post_link, post_text, experience_7d,
    comments_count, initial_comments_count, post_created_at, first_seen_at
    FROM superlike_posts
    WHERE COALESCE(current_has_superlike, 0) = 0
      AND experience_7d IS NOT NULL AND experience_7d >= ?
      AND COALESCE(comments_count, 0) <= ?
      AND post_link IS NOT NULL AND TRIM(post_link) <> ''
      AND post_created_at IS NOT NULL
    ORDER BY experience_7d DESC, first_seen_at DESC`).all(MIN_EXPERIENCE, MAX_COMMENTS);
  const todayRows = rows.filter(row => formatShanghaiDate(row.post_created_at) === today);
  todayRows.sort((a, b) => {
    const e = Number(b.experience_7d || 0) - Number(a.experience_7d || 0);
    if (e !== 0) return e;
    const p = new Date(b.post_created_at).getTime() - new Date(a.post_created_at).getTime();
    if (Number.isFinite(p) && p !== 0) return p;
    return new Date(b.first_seen_at || 0).getTime() - new Date(a.first_seen_at || 0).getTime();
  });
  return todayRows.slice(0, LIMIT);
}

async function launchBrowser(headless) {
  const options = { headless, viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true };
  if (ACCOUNT_PROXY) options.proxy = toPlaywrightProxy(ACCOUNT_PROXY);
  return chromium.launchPersistentContext(PROFILE_DIR, options);
}
async function hasWeiboLogin(context) {
  const cookies = await context.cookies('https://weibo.com');
  return cookies.some(c => c.name === 'SUB' && c.value);
}
async function waitForManualLogin(context, rl) {
  while (true) {
    await rl.question('[登录] 请在 Chrome 完成微博登录；完成后按 Enter：');
    if (await hasWeiboLogin(context)) return;
    console.log('[登录] 仍未检测到 SUB Cookie，请继续登录。');
  }
}
async function collectBrowserSession(context) {
  const page = context.pages()[0] || await context.newPage();
  let browserInfo = null;
  try {
    browserInfo = await page.evaluate(() => ({ userAgent: navigator.userAgent, language: navigator.language }));
  } catch {}
  return {
    cookies: await context.cookies(),
    userAgent: browserInfo?.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
    language: browserInfo?.language || 'zh-CN'
  };
}
async function browserLoginSession(rl, forceLogin = false) {
  console.log(`[账号] ${ACCOUNT}`);
  console.log('[登录] 临时启动 Chromium 读取登录态。');
  let context = await launchBrowser(true);
  try {
    if (!forceLogin && await hasWeiboLogin(context)) {
      const session = await collectBrowserSession(context);
      console.log(`[登录] 已读取 Cookie=${session.cookies.length}，关闭 Chromium。`);
      return session;
    }
  } finally {
    await context.close().catch(() => {});
  }

  console.log('[登录] 登录态不存在或已失效，临时打开可见 Chromium。');
  context = await launchBrowser(false);
  try {
    if (forceLogin) await context.clearCookies().catch(() => {});
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://weibo.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await waitForManualLogin(context, rl);
    const session = await collectBrowserSession(context);
    console.log(`[登录] 已取得 Cookie=${session.cookies.length}，关闭 Chromium。`);
    return session;
  } finally {
    await context.close().catch(() => {});
  }
}
async function createHttpContext(session) {
  const options = {
    ignoreHTTPSErrors: true,
    userAgent: session.userAgent,
    storageState: { cookies: session.cookies, origins: [] },
    extraHTTPHeaders: {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': session.language || 'zh-CN'
    }
  };
  if (ACCOUNT_PROXY) options.proxy = toPlaywrightProxy(ACCOUNT_PROXY);
  return request.newContext(options);
}
async function getHttpCookies(api) {
  const state = await api.storageState();
  return Array.isArray(state.cookies) ? state.cookies : [];
}
function findCsrfToken(cookies) {
  for (const name of ['XSRF-TOKEN', 'XSRF_TOKEN', 'csrf', 'csrf_token', 'CSRF-TOKEN', '_csrf']) {
    const found = cookies.find(c => c.name === name && c.value);
    if (found) return { token: decodeURIComponent(found.value), source: `cookie:${name}` };
  }
  return null;
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
  return { status: response.status(), url: response.url(), ok: response.ok() };
}
async function sendCommentHttp(api, postId, postLink, commentText) {
  let cookies = await getHttpCookies(api);
  let csrf = findCsrfToken(cookies);
  if (!csrf) {
    await warmPost(api, postLink).catch(() => {});
    cookies = await getHttpCookies(api);
    csrf = findCsrfToken(cookies);
  }
  if (!csrf) return { ok: false, status: 0, json: null, text: 'CSRF token not found', csrfSource: null };

  const form = {
    id: String(postId), comment: commentText, pic_id: '', is_repost: '0', comment_ori: '0', is_comment: '0'
  };
  if (COMMENT_FP) form.fp = COMMENT_FP;

  const response = await api.post('https://weibo.com/ajax/comments/create', {
    timeout: HTTP_TIMEOUT_MS,
    failOnStatusCode: false,
    form,
    headers: {
      Accept: 'application/json, text/plain, */*',
      Referer: postLink,
      'X-Requested-With': 'XMLHttpRequest',
      'X-XSRF-TOKEN': csrf.token,
      'X-CSRF-TOKEN': csrf.token
    }
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: response.ok(), status: response.status(), json, text, csrfSource: csrf.source, finalUrl: response.url() };
}
function getBusinessCode(result) {
  const body = result?.json || {};
  if (body.ok !== undefined) return body.ok;
  if (body.code !== undefined) return body.code;
  if (body.error_code !== undefined) return body.error_code;
  return null;
}
function isCommentSuccess(result) {
  if (!result?.ok || !result.json || typeof result.json !== 'object') return false;
  if (result.json.ok !== undefined) return Number(result.json.ok) === 1;
  if (result.json.code !== undefined) return Number(result.json.code) === 0;
  if (result.json.error_code !== undefined) return Number(result.json.error_code) === 0;
  return false;
}
function isLoginExpiredResult(result) {
  const body = result?.json || {};
  const code = Number(body.ok ?? body.code ?? body.error_code);
  const redirectUrl = String(body.url || body.redirect || result?.finalUrl || '');
  return code === -100 || /newlogin|passport\.weibo|\/login/i.test(redirectUrl);
}
function summarizeResult(result) {
  if (!result) return '没有返回结果';
  const body = result.json || {};
  const code = getBusinessCode(result);
  const message = body.msg || body.message || body.error || '';
  return [`HTTP ${result.status}`, code !== null ? `code=${code}` : '', message ? `msg=${message}` : '',
    result.csrfSource ? `csrf=${result.csrfSource}` : ''].filter(Boolean).join(' | ');
}
async function rebuildHttpSession(rl, forceLogin = false) {
  const browserSession = await browserLoginSession(rl, forceLogin);
  const api = await createHttpContext(browserSession);
  console.log(`[HTTP评论] 会话创建完成 | Proxy=${ACCOUNT_PROXY ? maskProxy(ACCOUNT_PROXY) : 'DIRECT'}`);
  console.log('[HTTP评论] Chromium已关闭；下面全部使用 APIRequestContext。');
  return api;
}

async function main() {
  initDatabase();
  initializeAccountProxy();
  const rl = readline.createInterface({ input, output });
  let api = null;
  try {
    api = await rebuildHttpSession(rl, false);
    const targets = getTargets();
    if (!targets.length) {
      console.log(`没有符合条件的当天帖子：experience_7d >= ${MIN_EXPERIENCE}, comments_count <= ${MAX_COMMENTS}`);
      return;
    }
    console.log(`当天候选帖子 ${targets.length} 条，按经验值从高到低。`);
    console.log('每条评论发送前都会要求你确认。');
    console.log(`默认评论：${DEFAULT_COMMENT}`);

    for (let i = 0; i < targets.length; i += 1) {
      const row = targets[i];
      console.log('\n==============================================');
      console.log(`[${i + 1}/${targets.length}] 经验值=${row.experience_7d} | 初始评论=${row.initial_comments_count ?? '-'}`);
      console.log(`UID=${row.uid || '-'} | ${row.username || '-'}`);
      console.log(`Post=${row.post_id}`);
      console.log(`Link=${row.post_link}`);
      if (row.post_text) console.log(`文案=${String(row.post_text).replace(/\s+/g, ' ').slice(0, 160)}`);

      let warm;
      try {
        warm = await warmPost(api, row.post_link);
        console.log(`[HTTP评论] 帖子GET=${warm.status} | finalUrl=${warm.url}`);
      } catch (error) {
        console.warn(`[HTTP评论] 帖子GET失败：${error.message}`);
        continue;
      }
      if (/passport\.weibo|\/login|newlogin/i.test(String(warm.url || ''))) {
        console.log('[登录] HTTP会话已失效，只为当前账号临时启动 Chromium 重新登录。');
        await api.dispose().catch(() => {});
        api = await rebuildHttpSession(rl, true);
        i -= 1;
        continue;
      }

      const csrf = findCsrfToken(await getHttpCookies(api));
      console.log(`[评论] 初始=${row.initial_comments_count ?? '-'} | 当前评论数=跳过实时获取`);
      console.log(csrf ? `[CSRF] 已找到：${csrf.source}` : '[CSRF] HTTP Cookie中未找到 token');
      const answer = (await rl.question(`发送评论“${DEFAULT_COMMENT}”？输入 y 发送；s 跳过；q 退出：`)).trim().toLowerCase();
      if (answer === 'q') break;
      if (answer !== 'y') continue;

      try {
        const result = await sendCommentHttp(api, row.post_id, row.post_link, DEFAULT_COMMENT);
        const success = isCommentSuccess(result);
        console.log(`[评论结果] ${success ? '✅ 成功' : '❌ 失败'} | ${summarizeResult(result)}`);
        if (!success && result?.text) console.log(`[微博返回] ${String(result.text).slice(0, 1000)}`);

        if (isLoginExpiredResult(result)) {
          console.log('[登录] 微博返回登录失效，只为当前账号临时启动 Chromium 重新登录。');
          await api.dispose().catch(() => {});
          api = await rebuildHttpSession(rl, true);
          console.log('[登录] 已恢复HTTP会话；当前帖子重新显示，不会自动重发。');
          i -= 1;
        }
      } catch (error) {
        console.error(`[评论失败] ${error.message}`);
      }
    }
  } finally {
    if (api) await api.dispose().catch(() => {});
    rl.close();
  }
}

main().catch(error => {
  console.error('[comment-assistant] 异常：', error);
  process.exitCode = 1;
});
