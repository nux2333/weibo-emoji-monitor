const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const { chromium, request } = require('playwright');
const { db, initDatabase } = require('../../src/db');

const ROOT = path.join(__dirname, '..', '..');
const PROFILE_DIR = process.env.COMMENT_ASSISTANT_PROFILE
  ? path.resolve(process.env.COMMENT_ASSISTANT_PROFILE)
  : path.join(ROOT, 'data', 'comment-assistant-profile');

const GOOD_PROXY_FILE = process.env.WEIBO_GOOD_PROXY_FILE
  ? path.resolve(process.env.WEIBO_GOOD_PROXY_FILE)
  : path.join(ROOT, 'data', 'weibo-good-proxies.txt');

const MIN_EXPERIENCE = Number(process.env.COMMENT_MIN_EXPERIENCE || 70);
const LIMIT = Number(process.env.COMMENT_TARGET_LIMIT || 20);
const MAX_COMMENTS = Number(process.env.COMMENT_MAX_EXISTING_COMMENTS || 19);
const DEFAULT_COMMENT = process.env.COMMENT_TEXT || '[泪奔][泪奔][泪奔][泪奔][泪奔]';
const COMMENT_FP = process.env.COMMENT_FP || '';

function normalizeProxy(rawValue) {
  const raw = String(rawValue || '').split('#')[0].trim();
  if (!raw) return null;
  return /^(?:https?|socks5):\/\//i.test(raw) ? raw : `http://${raw}`;
}

function readGoodProxyPool() {
  try {
    if (!fs.existsSync(GOOD_PROXY_FILE)) return [];
    return Array.from(new Set(
      fs.readFileSync(GOOD_PROXY_FILE, 'utf8')
        .split(/\r?\n/)
        .map(normalizeProxy)
        .filter(Boolean)
    ));
  } catch (error) {
    console.warn(`[代理池] 读取失败：${error.message}`);
    return [];
  }
}

function toPlaywrightProxy(rawValue) {
  const normalized = normalizeProxy(rawValue);
  if (!normalized) return null;

  try {
    const parsed = new URL(normalized);
    const proxy = {
      server: `${parsed.protocol}//${parsed.hostname}${parsed.port ? ':' + parsed.port : ''}`
    };
    if (parsed.username) proxy.username = decodeURIComponent(parsed.username);
    if (parsed.password) proxy.password = decodeURIComponent(parsed.password);
    return proxy;
  } catch {
    return { server: normalized };
  }
}

function maskProxy(rawValue) {
  try {
    const parsed = new URL(rawValue);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? ':' + parsed.port : ''}`;
  } catch {
    return String(rawValue || '').replace(/\/\/[^@]+@/, '//***@');
  }
}

function pickRandomHealthyProxy() {
  const items = readGoodProxyPool();
  if (!items.length) return null;
  return items[Math.floor(Math.random() * items.length)];
}

async function createReadOnlyProxyContext(proxy) {
  if (!proxy) return null;

  return request.newContext({
    proxy: toPlaywrightProxy(proxy),
    ignoreHTTPSErrors: true,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
      + 'AppleWebKit/537.36 (KHTML, like Gecko) '
      + 'Chrome/152.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      Accept: 'text/html,application/xhtml+xml,application/json,text/plain,*/*'
    }
  });
}

async function readPostViaProxy(apiContext, url) {
  if (!apiContext) return null;

  try {
    const response = await apiContext.get(url, {
      timeout: 10000,
      failOnStatusCode: false
    });

    return {
      status: response.status(),
      ok: response.ok()
    };
  } catch (error) {
    return {
      status: null,
      ok: false,
      error: error.message
    };
  }
}

function getTargets() {
  return db.prepare(`
    SELECT
      post_id,
      uid,
      username,
      post_link,
      post_text,
      experience_7d,
      comments_count,
      initial_comments_count,
      post_created_at
    FROM superlike_posts
    WHERE COALESCE(current_has_superlike, 0) = 0
      AND experience_7d IS NOT NULL
      AND experience_7d >= ?
      AND COALESCE(comments_count, 0) <= ?
      AND post_link IS NOT NULL
      AND TRIM(post_link) <> ''
    ORDER BY
      experience_7d DESC,
      post_created_at DESC,
      first_seen_at DESC
    LIMIT ?
  `).all(MIN_EXPERIENCE, MAX_COMMENTS, LIMIT);
}

async function getCurrentCommentCountFromApi(page, postId, uid) {
  return page.evaluate(
    async ({ postId, uid }) => {
      const url = new URL('/ajax/statuses/buildComments', location.origin);
      url.searchParams.set('is_reload', '1');
      url.searchParams.set('id', String(postId));
      url.searchParams.set('is_show_bulletin', '3');
      url.searchParams.set('is_mix', '0');
      url.searchParams.set('count', '10');
      url.searchParams.set('uid', String(uid || ''));
      url.searchParams.set('fetch_level', '0');
      url.searchParams.set('locale', 'zh-CN');

      try {
        const response = await fetch(url.toString(), {
          method: 'GET',
          credentials: 'include',
          headers: {
            Accept: 'application/json, text/plain, */*',
            'X-Requested-With': 'XMLHttpRequest'
          }
        });

        const text = await response.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // Keep raw response for diagnostics.
        }

        const total = Number(json?.total_number);
        return {
          ok: response.ok && json?.ok === 1 && Number.isFinite(total),
          status: response.status,
          totalNumber: Number.isFinite(total) ? total : null,
          apiOk: json?.ok ?? null,
          message: json?.message || json?.msg || '',
          raw: text.slice(0, 300)
        };
      } catch (error) {
        return {
          ok: false,
          status: null,
          totalNumber: null,
          apiOk: null,
          message: error.message,
          raw: ''
        };
      }
    },
    { postId, uid }
  );
}

async function getCurrentCommentCountFromDom(page) {
  return page.evaluate(() => {
    function parseCount(raw) {
      const text = String(raw || '').replace(/,/g, '').trim();
      if (!text) return null;

      const patterns = [
        /评论\s*[（(]?\s*(\d+)\s*[）)]?/i,
        /共\s*(\d+)\s*条?评论/i,
        /(\d+)\s*条?评论/i
      ];

      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) return Number(match[1]);
      }

      return null;
    }

    const preferredSelectors = [
      '[aria-label*="评论"]',
      '[title*="评论"]',
      'button',
      'a',
      '[role="button"]'
    ];

    for (const selector of preferredSelectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      for (const node of nodes) {
        const candidates = [
          node.getAttribute && node.getAttribute('aria-label'),
          node.getAttribute && node.getAttribute('title'),
          node.textContent
        ];

        for (const candidate of candidates) {
          const count = parseCount(candidate);
          if (Number.isFinite(count)) return count;
        }
      }
    }

    const bodyText = document.body ? document.body.innerText : '';
    return parseCount(bodyText);
  }).catch(() => null);
}

async function getCurrentCommentCount(page, postId, uid) {
  const apiResult = await getCurrentCommentCountFromApi(page, postId, uid);

  if (apiResult?.ok && Number.isFinite(apiResult.totalNumber)) {
    return {
      count: apiResult.totalNumber,
      source: 'buildComments',
      apiResult
    };
  }

  const domCount = await getCurrentCommentCountFromDom(page);
  return {
    count: Number.isFinite(domCount) ? domCount : null,
    source: Number.isFinite(domCount) ? 'DOM回退' : null,
    apiResult
  };
}

async function getCsrfToken(page, context) {
  const cookieCandidates = [
    'XSRF-TOKEN',
    'XSRF_TOKEN',
    'csrf',
    'csrf_token',
    'CSRF-TOKEN',
    '_csrf'
  ];

  const cookies = await context.cookies('https://weibo.com');
  for (const name of cookieCandidates) {
    const found = cookies.find(cookie => cookie.name === name && cookie.value);
    if (found) {
      return {
        token: decodeURIComponent(found.value),
        source: `cookie:${name}`
      };
    }
  }

  const fromPage = await page.evaluate(() => {
    const selectors = [
      'meta[name="csrf-token"]',
      'meta[name="csrf_token"]',
      'meta[name="xsrf-token"]',
      'meta[name="x-xsrf-token"]'
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const value = el && el.getAttribute('content');
      if (value) {
        return {
          token: value,
          source: `meta:${selector}`
        };
      }
    }

    const globals = [
      ['window.$CONFIG.csrf', window.$CONFIG && window.$CONFIG.csrf],
      ['window.$CONFIG.csrf_token', window.$CONFIG && window.$CONFIG.csrf_token],
      ['window.__INITIAL_STATE__.csrf', window.__INITIAL_STATE__ && window.__INITIAL_STATE__.csrf],
      ['window.__INITIAL_STATE__.csrfToken', window.__INITIAL_STATE__ && window.__INITIAL_STATE__.csrfToken]
    ];

    for (const [source, value] of globals) {
      if (value) return { token: String(value), source };
    }

    return null;
  }).catch(() => null);

  return fromPage;
}

async function sendComment(page, context, postId, commentText) {
  const csrf = await getCsrfToken(page, context);

  if (!csrf?.token) {
    return {
      ok: false,
      status: 0,
      json: null,
      text: 'CSRF token not found',
      csrfSource: null
    };
  }

  const result = await page.evaluate(
    async ({ postId, commentText, fp, csrfToken }) => {
      const form = new URLSearchParams();
      form.set('id', String(postId));
      form.set('comment', commentText);
      form.set('pic_id', '');
      form.set('is_repost', '0');
      form.set('comment_ori', '0');
      form.set('is_comment', '0');
      if (fp) form.set('fp', fp);

      const response = await fetch('/ajax/comments/create', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'X-XSRF-TOKEN': csrfToken,
          'X-CSRF-TOKEN': csrfToken,
          Accept: 'application/json, text/plain, */*'
        },
        body: form.toString()
      });

      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // Keep raw body for diagnostics.
      }

      return {
        ok: response.ok,
        status: response.status,
        json,
        text
      };
    },
    {
      postId,
      commentText,
      fp: COMMENT_FP,
      csrfToken: csrf.token
    }
  );

  return {
    ...result,
    csrfSource: csrf.source
  };
}

function summarizeResult(result) {
  if (!result) return '没有返回结果';

  const body = result.json || {};
  const code = body.ok ?? body.code ?? body.error_code ?? '';
  const message = body.msg || body.message || body.error || '';

  return [
    `HTTP ${result.status}`,
    code !== '' ? `code=${code}` : '',
    message ? `msg=${message}` : '',
    result.csrfSource ? `csrf=${result.csrfSource}` : ''
  ].filter(Boolean).join(' | ');
}

async function main() {
  initDatabase();

  const targets = getTargets();
  if (!targets.length) {
    console.log(
      `没有符合条件的帖子：experience_7d >= ${MIN_EXPERIENCE}, comments_count <= ${MAX_COMMENTS}`
    );
    return;
  }

  console.log(`候选帖子 ${targets.length} 条，按经验值从高到低。`);
  console.log('每条评论发送前都会要求你确认。');
  console.log(`默认评论：${DEFAULT_COMMENT}`);
  if (!COMMENT_FP) {
    console.log('COMMENT_FP 未设置：先尝试不传 fp；如果微博返回参数错误，再设置抓包里的 fp。');
  }

  const selectedProxy = pickRandomHealthyProxy();
  let readOnlyProxyContext = null;

  if (selectedProxy) {
    console.log(`[只读代理] 健康池=${GOOD_PROXY_FILE}`);
    console.log(`[只读代理] 本轮固定使用：${maskProxy(selectedProxy)}`);
    try {
      readOnlyProxyContext = await createReadOnlyProxyContext(selectedProxy);
    } catch (error) {
      console.warn(`[只读代理] 创建失败：${error.message}`);
    }
  } else {
    console.log(`[只读代理] 未找到健康代理：${GOOD_PROXY_FILE}`);
  }

  // 登录浏览器保持直连。评论 POST 也从这个未配置代理的 context 发出。
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 }
  });

  const pages = context.pages();
  const page = pages[0] || await context.newPage();
  const rl = readline.createInterface({ input, output });

  try {
    for (let i = 0; i < targets.length; i += 1) {
      const row = targets[i];

      console.log('\n==============================================');
      console.log(`[${i + 1}/${targets.length}] 经验值=${row.experience_7d} | 初始评论=${row.initial_comments_count ?? '-'}`);
      console.log(`UID=${row.uid || '-'} | ${row.username || '-'}`);
      console.log(`Post=${row.post_id}`);
      console.log(`Link=${row.post_link}`);
      if (row.post_text) {
        console.log(`文案=${String(row.post_text).replace(/\s+/g, ' ').slice(0, 160)}`);
      }

      if (readOnlyProxyContext) {
        const proxyResult = await readPostViaProxy(readOnlyProxyContext, row.post_link);
        if (proxyResult?.ok) {
          console.log(`[只读代理] GET ${proxyResult.status} OK`);
        } else if (proxyResult?.status) {
          console.log(`[只读代理] GET HTTP ${proxyResult.status}`);
        } else if (proxyResult?.error) {
          console.log(`[只读代理] GET失败：${proxyResult.error}`);
        }
      }

      await page.goto(row.post_link, {
        waitUntil: 'domcontentloaded',
        timeout: 20000
      }).catch(error => {
        console.warn(`打开失败：${error.message}`);
      });

      await page.waitForTimeout(1200);

      const currentCommentResult = await getCurrentCommentCount(page, row.post_id, row.uid);
      if (Number.isFinite(currentCommentResult.count)) {
        console.log(
          `[评论] 初始=${row.initial_comments_count ?? '-'} | 当前=${currentCommentResult.count} | 来源=${currentCommentResult.source}`
        );
      } else {
        const api = currentCommentResult.apiResult;
        const detail = api
          ? `HTTP=${api.status ?? '-'} | ok=${api.apiOk ?? '-'} | ${api.message || '无返回消息'}`
          : 'buildComments 未返回结果';
        console.log(
          `[评论] 初始=${row.initial_comments_count ?? '-'} | 当前=未获取到 | ${detail}`
        );
      }

      const csrf = await getCsrfToken(page, context);
      console.log(
        csrf?.token
          ? `[CSRF] 已找到：${csrf.source}`
          : '[CSRF] 未找到 token'
      );

      const answer = (await rl.question(
        `发送评论“${DEFAULT_COMMENT}”？输入 y 发送；s 跳过；q 退出：`
      )).trim().toLowerCase();

      if (answer === 'q') break;
      if (answer !== 'y') continue;

      try {
        const result = await sendComment(page, context, row.post_id, DEFAULT_COMMENT);
        console.log(`[评论结果] ${summarizeResult(result)}`);

        if (!result.ok || (result.json && result.json.ok === 0)) {
          const raw = result.text ? String(result.text).slice(0, 500) : '';
          if (raw) console.log(`[返回内容] ${raw}`);
        }
      } catch (error) {
        console.error(`[评论失败] ${error.message}`);
      }
    }
  } finally {
    rl.close();
    if (readOnlyProxyContext) await readOnlyProxyContext.dispose().catch(() => {});
    await context.close();
  }
}

main().catch(error => {
  console.error('[comment-assistant] 异常：', error);
  process.exitCode = 1;
});
