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
const PROXY_RETRIES = Math.max(1, Number(process.env.COMMENT_PROXY_RETRIES || 3));
const LOGIN_TEST_URL = 'https://weibo.com/newlogin?tabtype=weibo&gid=102803&openLoginLayer=0&url=https://weibo.com/';
let ACCOUNT_PROXY = null;
let PROXY_POOL = [];
let PROXY_INDEX = -1;

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
  const override = normalizeProxy(COMMENT_BROWSER_PROXY);
  const healthy = readGoodProxyPool();
  PROXY_POOL = override
    ? [override, ...healthy.filter(proxy => proxy !== override)]
    : healthy;
  if (!PROXY_POOL.length) {
    ACCOUNT_PROXY = null;
    PROXY_INDEX = -1;
    console.warn('[账号代理] 健康代理池为空，本次尝试直连。');
    return null;
  }
  PROXY_INDEX = override ? 0 : Math.floor(Math.random() * PROXY_POOL.length);
  ACCOUNT_PROXY = PROXY_POOL[PROXY_INDEX];
  console.log(`[账号代理] 本次使用：${maskProxy(ACCOUNT_PROXY)} | 健康池=${PROXY_POOL.length}${override ? ' | 固定代理优先' : ''}`);
  return ACCOUNT_PROXY;
}
function rotateAccountProxy() {
  if (PROXY_POOL.length <= 1) return false;
  PROXY_INDEX = (PROXY_INDEX + 1) % PROXY_POOL.length;
  ACCOUNT_PROXY = PROXY_POOL[PROXY_INDEX];
  console.log(`[代理切换] → ${maskProxy(ACCOUNT_PROXY)}`);
  return true;
}
function shortError(error) {
  const text = String(error?.message || error || 'unknown error');
  const first = text.split(/\r?\n/)[0];
  const match = first.match(/(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_[A-Z_]+|socket hang up|Timeout[^:]*)/i);
  return match ? match[1] : first.replace(/^apiRequestContext\.(?:get|post):\s*/i, '').slice(0, 180);
}
function isHttp4xx(status) {
  const code = Number(status);
  return code >= 400 && code < 500;
}
function isLoginUrl(url) {
  return /newlogin|passport\.weibo|\/login/i.test(String(url || ''));
}

function initCommentHistory() {
  db.exec(`CREATE TABLE IF NOT EXISTS comment_assistant_history (
    account TEXT NOT NULL,
    post_id TEXT NOT NULL,
    commented_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account, post_id)
  )`);
}
function hasCommented(postId) {
  return Boolean(db.prepare('SELECT 1 FROM comment_assistant_history WHERE account = ? AND post_id = ? LIMIT 1').get(ACCOUNT, String(postId)));
}
function rememberCommented(postId) {
  db.prepare(`INSERT INTO comment_assistant_history (account, post_id, commented_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (account, post_id) DO NOTHING`).run(ACCOUNT, String(postId));
}
function getCommentedCount() {
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM comment_assistant_history WHERE account = ?').get(ACCOUNT);
  return Number(row?.cnt || 0);
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
  return todayRows.filter(row => !hasCommented(row.post_id)).slice(0, LIMIT);
}

async function launchBrowser(headless, useProxy = true) {
  const options = { headless, viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true };
  if (useProxy && ACCOUNT_PROXY) options.proxy = toPlaywrightProxy(ACCOUNT_PROXY);
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
  try { browserInfo = await page.evaluate(() => ({ userAgent: navigator.userAgent, language: navigator.language })); } catch {}
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
  } finally { await context.close().catch(() => {}); }

  console.log('[登录] 登录态不存在或已失效，使用本地IP直接打开登录页。');
  context = await launchBrowser(false, false);
  try {
    if (forceLogin) await context.clearCookies().catch(() => {});
    const page = context.pages()[0] || await context.newPage();
    await page.goto(LOGIN_TEST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('[登录] 登录页已打开 | Proxy=DIRECT');
    await waitForManualLogin(context, rl);
    const session = await collectBrowserSession(context);
    console.log(`[登录] 已取得 Cookie=${session.cookies.length}，关闭 Chromium。`);
    return session;
  } finally { await context.close().catch(() => {}); }
}
async function createHttpContext(session) {
  const options = {
    ignoreHTTPSErrors: true,
    userAgent: session.userAgent,
    storageState: { cookies: session.cookies, origins: [] },
    extraHTTPHeaders: { Accept: 'application/json, text/plain, */*', 'Accept-Language': session.language || 'zh-CN' }
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
  const csrf = findCsrfToken(await getHttpCookies(api));
  if (!csrf) {
    return { ok: false, status: null, json: null, text: 'CSRF token unavailable before comment POST', csrfSource: null, csrfMissing: true };
  }
  const form = { id: String(postId), comment: commentText, pic_id: '', is_repost: '0', comment_ori: '0', is_comment: '0' };
  if (COMMENT_FP) form.fp = COMMENT_FP;
  const response = await api.post('https://weibo.com/ajax/comments/create', {
    timeout: HTTP_TIMEOUT_MS,
    failOnStatusCode: false,
    form,
    headers: {
      Accept: 'application/json, text/plain, */*', Referer: postLink, 'X-Requested-With': 'XMLHttpRequest',
      'X-XSRF-TOKEN': csrf.token, 'X-CSRF-TOKEN': csrf.token
    }
  });
  const text = await response.text();
  let json = null; try { json = JSON.parse(text); } catch {}
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
  if (result?.csrfMissing) return true;
  const body = result?.json || {};
  const code = Number(body.ok ?? body.code ?? body.error_code);
  const redirectUrl = String(body.url || body.redirect || result?.finalUrl || '');
  return code === -100 || isLoginUrl(redirectUrl);
}
function summarizeResult(result) {
  if (!result) return '没有返回结果';
  if (result.csrfMissing) return 'CSRF token unavailable';
  const body = result.json || {}, code = getBusinessCode(result), message = body.msg || body.message || body.error || '';
  return [`HTTP ${result.status}`, code !== null ? `code=${code}` : '', message ? `msg=${message}` : '',
    result.csrfSource ? `csrf=${result.csrfSource}` : ''].filter(Boolean).join(' | ');
}
async function rebuildHttpSession(rl, forceLogin = false, existingSession = null) {
  const browserSession = existingSession || await browserLoginSession(rl, forceLogin);
  const api = await createHttpContext(browserSession);
  console.log(`[HTTP评论] 会话创建完成 | Proxy=${ACCOUNT_PROXY ? maskProxy(ACCOUNT_PROXY) : 'DIRECT'}`);
  return { api, browserSession };
}
async function rotateHttpSession(currentApi, browserSession) {
  if (!rotateAccountProxy()) return null;
  if (currentApi) await currentApi.dispose().catch(() => {});
  return createHttpContext(browserSession);
}

async function refreshCsrfBeforePrompt(api, browserSession, postLink) {
  let currentApi = api;
  let lastWarm = null;
  let lastError = null;

  let csrf = findCsrfToken(await getHttpCookies(currentApi));
  if (csrf) return { api: currentApi, csrf, loginExpired: false, error: null };

  console.log('[CSRF] HTTP Cookie中未找到 token，刷新帖子Cookie。');
  for (let attempt = 1; attempt <= PROXY_RETRIES; attempt += 1) {
    try {
      lastWarm = await warmPost(currentApi, postLink);
      if (isLoginUrl(lastWarm.url)) {
        return { api: currentApi, csrf: null, loginExpired: true, error: null };
      }
      if (isHttp4xx(lastWarm.status)) {
        console.warn(`[CSRF] 刷新帖子 HTTP ${lastWarm.status}，自动切换代理`);
        if (attempt >= PROXY_RETRIES) break;
        const nextApi = await rotateHttpSession(currentApi, browserSession);
        if (!nextApi) {
          lastError = new Error(`HTTP ${lastWarm.status}，没有可切换代理`);
          break;
        }
        currentApi = nextApi;
        continue;
      }

      csrf = findCsrfToken(await getHttpCookies(currentApi));
      if (csrf) {
        if (attempt > 1) console.log(`[CSRF] 刷新成功 | HTTP=${lastWarm.status}`);
        return { api: currentApi, csrf, loginExpired: false, error: null };
      }
      lastError = new Error('刷新帖子后仍未取得 CSRF token');
    } catch (error) {
      lastError = error;
      console.warn(`[CSRF] 刷新帖子失败：${shortError(error)}`);
      if (attempt >= PROXY_RETRIES) break;
      const nextApi = await rotateHttpSession(currentApi, browserSession);
      if (!nextApi) break;
      currentApi = nextApi;
    }
  }

  return { api: currentApi, csrf: null, loginExpired: true, error: lastError || new Error(`HTTP ${lastWarm?.status ?? '-'}`) };
}

async function main() {
  initDatabase();
  initCommentHistory();
  initializeAccountProxy();
  const rl = readline.createInterface({ input, output });
  let api = null;
  let browserSession = null;
  try {
    ({ api, browserSession } = await rebuildHttpSession(rl, false));
    const targets = getTargets();
    const commentedCount = getCommentedCount();
    console.log(`[去重] 账号=${ACCOUNT} | 已评论记录=${commentedCount}`);
    if (!targets.length) {
      console.log(`没有符合条件且该账号未评论过的当天帖子：experience_7d >= ${MIN_EXPERIENCE}, comments_count <= ${MAX_COMMENTS}`);
      return;
    }
    console.log(`当天候选帖子 ${targets.length} 条，按经验值从高到低。`);
    console.log(`默认评论：${DEFAULT_COMMENT}`);

    for (let i = 0; i < targets.length; i += 1) {
      const row = targets[i];
      console.log('\n==============================================');
      console.log(`[${i + 1}/${targets.length}] 经验值=${row.experience_7d} | 初始评论=${row.initial_comments_count ?? '-'} | UID=${row.uid || '-'} | ${row.username || '-'}`);
      console.log(`Link=${row.post_link}`);

      let warm = null;
      let warmError = null;
      for (let attempt = 1; attempt <= PROXY_RETRIES; attempt += 1) {
        try {
          const candidateWarm = await warmPost(api, row.post_link);
          if (isHttp4xx(candidateWarm.status)) {
            console.warn(`[HTTP评论] 帖子GET HTTP ${candidateWarm.status}，自动切换代理`);
            if (attempt >= PROXY_RETRIES) {
              warmError = new Error(`HTTP ${candidateWarm.status}`);
              break;
            }
            const nextApi = await rotateHttpSession(api, browserSession);
            if (!nextApi) {
              warmError = new Error(`HTTP ${candidateWarm.status}，没有可切换代理`);
              break;
            }
            api = nextApi;
            continue;
          }
          warm = candidateWarm;
          warmError = null;
          if (attempt > 1) console.log(`[HTTP评论] 重试成功 | HTTP=${warm.status}`);
          break;
        } catch (error) {
          warmError = error;
          console.warn(`[HTTP评论] 帖子GET失败：${shortError(error)}`);
          if (attempt >= PROXY_RETRIES) break;
          const nextApi = await rotateHttpSession(api, browserSession);
          if (!nextApi) break;
          api = nextApi;
        }
      }
      if (!warm) {
        console.warn(`[HTTP评论] 重试后仍失败，跳过本条${warmError ? `：${shortError(warmError)}` : ''}`);
        continue;
      }
      if (isLoginUrl(warm.url)) {
        console.log('[登录] HTTP会话已失效，只为当前账号临时启动 Chromium 重新登录。');
        await api.dispose().catch(() => {});
        ({ api, browserSession } = await rebuildHttpSession(rl, true));
        i -= 1;
        continue;
      }

      const csrfState = await refreshCsrfBeforePrompt(api, browserSession, row.post_link);
      api = csrfState.api;
      if (!csrfState.csrf) {
        console.log(`[登录] CSRF 无法恢复${csrfState.error ? `：${shortError(csrfState.error)}` : ''}，重新登录。`);
        await api.dispose().catch(() => {});
        ({ api, browserSession } = await rebuildHttpSession(rl, true));
        console.log('[登录] 已恢复HTTP会话；当前帖子重新显示，不会自动发表评论。');
        i -= 1;
        continue;
      }

      const answer = (await rl.question(`发送评论“${DEFAULT_COMMENT}”？输入 y 发送；s 跳过；q 退出：`)).trim().toLowerCase();
      if (answer === 'q') break;
      if (answer !== 'y') continue;

      try {
        const result = await sendCommentHttp(api, row.post_id, row.post_link, DEFAULT_COMMENT);
        const success = isCommentSuccess(result);
        console.log(`[评论结果] ${success ? '✅ 成功' : '❌ 失败'} | ${summarizeResult(result)}`);
        if (success) rememberCommented(row.post_id);
        if (!success && result?.text) console.log(`[微博返回] ${String(result.text).slice(0, 500)}`);
        if (!success && isHttp4xx(result?.status)) {
          const nextApi = await rotateHttpSession(api, browserSession);
          if (nextApi) {
            api = nextApi;
            console.log(`[HTTP评论] HTTP ${result.status} → 已切换代理；当前帖子重新显示，不会自动重发。`);
            i -= 1;
            continue;
          }
          console.warn(`[HTTP评论] HTTP ${result.status}，但没有其他可用代理可切换。`);
        }
        if (isLoginExpiredResult(result)) {
          console.log('[登录] 微博会话失效，只为当前账号临时启动 Chromium 重新登录。');
          await api.dispose().catch(() => {});
          ({ api, browserSession } = await rebuildHttpSession(rl, true));
          console.log('[登录] 已恢复HTTP会话；当前帖子重新显示，不会自动重发。');
          i -= 1;
        }
      } catch (error) {
        console.error(`[评论失败] ${shortError(error)}`);
      }
    }
  } finally {
    if (api) await api.dispose().catch(() => {});
    rl.close();
  }
}

main().catch(error => {
  console.error(`[comment-assistant] 异常：${shortError(error)}`);
  process.exitCode = 1;
});
