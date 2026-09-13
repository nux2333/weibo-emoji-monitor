'use strict';

const path = require('path');
const { chromium, request } = require('playwright');
const { ProxyPool } = require('../proxy-pool');
const {
  shouldRotateProxy,
  shouldRotateProxyForNetworkError
} = require('../proxy-http-policy');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_PROFILE_DIR = process.env.WEIBO_JYZ_PROFILE
  ? path.resolve(process.env.WEIBO_JYZ_PROFILE)
  : path.join(ROOT, 'data', 'superlike-browser-profile-jyz');

const PROXY_POOL = new ProxyPool({
  filePath:
    process.env.WEIBO_GOOD_PROXY_FILE
    || path.join(ROOT, 'data', 'weibo-good-proxies.txt'),
  rawPool: process.env.JYZ_BACKFILL_PROXY_POOL || '',
  fallback:
    process.env.JYZ_BACKFILL_PROXY
    || process.env.WEIBO_PROXY
    || '',
  cooldownMs:
    Number(process.env.JYZ_BACKFILL_PROXY_COOLDOWN_MS)
    || 30 * 60 * 1000,
  name: 'jyz-http-client'
});

const HTTP_TIMEOUT_MS =
  Number(process.env.JYZ_HTTP_TIMEOUT_MS)
  || 12000;
const MAX_PROXY_ATTEMPTS = Math.max(
  1,
  Number(process.env.JYZ_BACKFILL_PROXY_RETRIES)
  || 5
);

let httpContext = null;
let currentProxyAssignment = null;
let creatingSession = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractExperience7d(currentInfo) {
  const text = String(currentInfo || '').trim();
  if (!text) return null;

  const match =
    text.match(/经验值\s*[：:]\s*(\d+)/)
    || text.match(/(\d+)\s*$/);

  if (!match) return null;

  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function buildUrls(topicHash, uid) {
  const pageId = '100808' + String(topicHash || '').trim();

  const referer = new URL('https://huati.weibo.cn/super/setting/icon');
  referer.searchParams.set('page_id', pageId);
  referer.searchParams.set('icon_type', '1');
  referer.searchParams.set('union_id', 'chao_like');
  referer.searchParams.set('param_uid', String(uid));

  const apiUrl = new URL('https://huati.weibo.cn/aj/setting/icon/getconfig');
  apiUrl.searchParams.set('type', '1');
  apiUrl.searchParams.set('union_id', 'chao_like');
  apiUrl.searchParams.set('page_id', pageId);
  apiUrl.searchParams.set('param_uid', String(uid));

  return {
    referer: referer.toString(),
    apiUrl: apiUrl.toString()
  };
}

async function acquireProxy() {
  while (true) {
    const assignment = await PROXY_POOL.acquire();

    if (assignment?.proxy && !assignment.allCoolingDown) {
      return assignment;
    }

    if (
      assignment?.allCoolingDown
      && Number.isFinite(Number(assignment.nextReadyAt))
    ) {
      const waitMs = Math.max(
        1000,
        Number(assignment.nextReadyAt) - Date.now()
      );
      console.log(
        '[JYZ HTTP][代理] 全部代理冷却中，等待 '
        + Math.ceil(waitMs / 1000)
        + ' 秒...'
      );
      await sleep(waitMs);
      continue;
    }

    console.log('[JYZ HTTP][代理] 健康代理池为空，暂时使用本地IP。');
    return {
      configured: false,
      raw: null,
      proxy: null,
      masked: 'LOCAL'
    };
  }
}

async function closeHttpContext() {
  const ctx = httpContext;
  httpContext = null;
  if (ctx) {
    await ctx.dispose().catch(() => {});
  }
}

async function rotateProxy(reason, remove = false) {
  if (currentProxyAssignment?.raw) {
    if (remove) {
      PROXY_POOL.remove(currentProxyAssignment.raw);
    } else {
      PROXY_POOL.markBlocked(currentProxyAssignment.raw);
    }

    console.log(
      '[JYZ HTTP][代理] 当前代理 '
      + currentProxyAssignment.masked
      + ' 因 '
      + reason
      + (remove ? ' 已移除' : ' 已进入冷却')
    );
  }

  await closeHttpContext();
  currentProxyAssignment = null;
}

async function bootstrapHttpSession(topicHash, uid) {
  if (httpContext) {
    return { ok: true, context: httpContext };
  }

  if (creatingSession) {
    return creatingSession;
  }

  creatingSession = (async () => {
    if (!currentProxyAssignment) {
      currentProxyAssignment = await acquireProxy();
    }

    const urls = buildUrls(topicHash, uid);
    let browserContext = null;

    try {
      console.log(
        '[JYZ HTTP][Session] Chromium仅初始化登录Cookie'
        + ' | UID=' + uid
        + ' | Proxy=' + (currentProxyAssignment?.masked || 'LOCAL')
      );

      browserContext = await chromium.launchPersistentContext(
        DEFAULT_PROFILE_DIR,
        {
          channel: 'chromium',
          headless: true,
          ignoreHTTPSErrors: true,
          ...(currentProxyAssignment?.proxy
            ? { proxy: currentProxyAssignment.proxy }
            : {}),
          viewport: { width: 1280, height: 900 }
        }
      );

      const pages = browserContext.pages();
      const page = pages[0] || await browserContext.newPage();

      const response = await page.goto(urls.referer, {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      });

      await sleep(500);

      const finalUrl = page.url();
      if (
        /passport\.weibo\.(cn|com)/i.test(finalUrl)
        || /login/i.test(finalUrl)
      ) {
        return {
          ok: false,
          message: 'JYZ profile未登录huati：' + finalUrl
        };
      }

      const cookies = await browserContext.cookies();
      const huatiCookies = cookies.filter(
        cookie => String(cookie?.domain || '').includes('weibo.cn')
      );

      console.log(
        '[JYZ HTTP][Session] 登录态初始化完成'
        + ' | HTTP=' + (response?.status?.() ?? '-')
        + ' | Cookie=' + cookies.length
        + ' | weibo.cn=' + huatiCookies.length
      );

      const independent = await request.newContext({
        ...(currentProxyAssignment?.proxy
          ? { proxy: currentProxyAssignment.proxy }
          : {}),
        storageState: { cookies, origins: [] },
        extraHTTPHeaders: {
          Accept: 'application/json, text/plain, */*',
          'X-Requested-With': 'XMLHttpRequest'
        },
        ignoreHTTPSErrors: true
      });

      httpContext = independent;

      await browserContext.close();
      browserContext = null;

      console.log('[JYZ HTTP][Session] Chromium已关闭；后续经验值全部走HTTP。');

      return { ok: true, context: independent };
    } catch (error) {
      return {
        ok: false,
        message: error?.message || String(error)
      };
    } finally {
      if (browserContext) {
        await browserContext.close().catch(() => {});
      }
    }
  })();

  try {
    return await creatingSession;
  } finally {
    creatingSession = null;
  }
}

async function queryOnce(topicHash, uid) {
  const bootstrap = await bootstrapHttpSession(topicHash, uid);
  if (!bootstrap.ok) return bootstrap;

  const urls = buildUrls(topicHash, uid);
  const startedAt = Date.now();

  try {
    const response = await bootstrap.context.get(urls.apiUrl, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: urls.referer
      },
      timeout: HTTP_TIMEOUT_MS,
      failOnStatusCode: false
    });

    const text = await response.text();
    const status = response.status();

    console.log(
      '[JYZ HTTP] UID=' + uid
      + ' | HTTP=' + status
      + ' | ' + (Date.now() - startedAt) + 'ms'
    );

    if (status < 200 || status >= 300) {
      return { ok: false, status, message: 'HTTP ' + status };
    }

    if (text.trimStart().startsWith('<')) {
      return {
        ok: false,
        sessionInvalid: true,
        message: '返回HTML，不是JSON'
      };
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (error) {
      return {
        ok: false,
        message: 'JSON解析失败：' + error.message
      };
    }

    if (Number(json?.code) !== 100000) {
      return {
        ok: false,
        status: Number(json?.code) === 418 ? 418 : null,
        message:
          'API code=' + (json?.code ?? '-')
          + ' msg=' + (json?.msg || '-')
      };
    }

    const currentInfo = json?.data?.current_info || '';
    const experience7d = extractExperience7d(currentInfo);

    if (experience7d === null) {
      return {
        ok: false,
        message: 'current_info没有可解析经验值'
      };
    }

    return {
      ok: true,
      experience7d,
      currentInfo,
      source: 'direct-http'
    };
  } catch (error) {
    return {
      ok: false,
      message: error?.message || String(error)
    };
  }
}

async function queryExperience7d(topicHash, uid) {
  let lastResult = null;

  for (let attempt = 1; attempt <= MAX_PROXY_ATTEMPTS; attempt++) {
    const result = await queryOnce(topicHash, uid);
    lastResult = result;

    if (result.ok) {
      return result;
    }

    if (
      result.sessionInvalid
      || shouldRotateProxy({ status: result.status })
    ) {
      await rotateProxy(
        result.message || 'HTTP/session blocked',
        false
      );
      console.log(
        '[JYZ HTTP][重试] UID=' + uid
        + ' | ' + (result.message || 'HTTP/session blocked')
        + ' → 换代理并重新初始化HTTP session'
        + ' | ' + attempt + '/' + MAX_PROXY_ATTEMPTS
      );
      continue;
    }

    if (shouldRotateProxyForNetworkError(result.message)) {
      await rotateProxy(
        result.message || '代理连接失败',
        true
      );
      console.log(
        '[JYZ HTTP][重试] UID=' + uid
        + ' | ' + (result.message || '代理连接失败')
        + ' → 淘汰当前代理并重试'
        + ' | ' + attempt + '/' + MAX_PROXY_ATTEMPTS
      );
      continue;
    }

    return result;
  }

  return lastResult || {
    ok: false,
    message: '代理重试次数已用完'
  };
}

async function closeJyzHttpClient() {
  await closeHttpContext();
}

module.exports = {
  queryExperience7d,
  closeJyzHttpClient
};
