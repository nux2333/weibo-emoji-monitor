const path = require('path');
const { chromium, request } = require('playwright');
const { ProxyPool } = require('../../src/proxy-pool');

const ROOT = path.join(__dirname, '..', '..');
const TOPIC_HASH = process.env.WEIBO_TOPIC_HASH || 'f1d33f71dff693a2708cb3e8ef584a44';
const UID = String(process.argv[2] || process.env.JYZ_TEST_UID || '8013047100').trim();
const PROFILE_DIR = process.env.WEIBO_JYZ_PROFILE
  ? path.resolve(process.env.WEIBO_JYZ_PROFILE)
  : path.join(ROOT, 'data', 'superlike-browser-profile-jyz');

const pool = new ProxyPool({
  filePath: process.env.WEIBO_GOOD_PROXY_FILE || path.join(ROOT, 'data', 'weibo-good-proxies.txt'),
  rawPool: process.env.JYZ_BACKFILL_PROXY_POOL || '',
  fallback: process.env.JYZ_BACKFILL_PROXY || process.env.WEIBO_PROXY || '',
  cooldownMs: 30 * 60 * 1000,
  name: 'jyz-abc-test'
});

function clip(text, max = 800) {
  return String(text || '').replace(/\s+/g, ' ').slice(0, max);
}

function selectedHeaders(headers) {
  const keys = [
    'content-type', 'server', 'location', 'set-cookie', 'x-cache',
    'cf-ray', 'via', 'x-request-id', 'x-s', 'x-t', 'date'
  ];
  const out = {};
  for (const key of keys) {
    if (headers?.[key] != null) out[key] = headers[key];
  }
  return out;
}

function cookieSummary(cookies) {
  return cookies.map(c => `${c.name}@${c.domain}`).join(',');
}

async function runRequest(label, api, url, headers) {
  const started = Date.now();
  try {
    const response = await api.get(url, {
      timeout: 15000,
      headers
    });
    const text = await response.text();
    console.log(`\n========== ${label} ==========`);
    console.log(`status=${response.status()}`);
    console.log(`finalUrl=${response.url()}`);
    console.log(`elapsed=${Date.now() - started}ms`);
    console.log(`headers=${JSON.stringify(selectedHeaders(response.headers()))}`);
    console.log(`body=${clip(text)}`);
    return { ok: true, status: response.status(), text, url: response.url() };
  } catch (error) {
    console.log(`\n========== ${label} ==========`);
    console.log(`ERROR=${error?.message || String(error)}`);
    console.log(`elapsed=${Date.now() - started}ms`);
    return { ok: false, status: null, error: error?.message || String(error) };
  }
}

(async () => {
  console.log('==============================================');
  console.log(`[JYZ A/B/C] UID=${UID}`);
  console.log('A=Browser fetch / B=browserContext.request / C=standalone request.newContext');
  console.log('==============================================');

  const assignment = await pool.acquire();
  if (!assignment?.proxy) throw new Error('没有可用健康代理');
  console.log(`[JYZ A/B/C] Proxy=${assignment.masked}`);

  const pageId = '100808' + TOPIC_HASH;
  const referer = new URL('https://huati.weibo.cn/super/setting/icon');
  referer.searchParams.set('page_id', pageId);
  referer.searchParams.set('icon_type', '1');
  referer.searchParams.set('union_id', 'chao_like');
  referer.searchParams.set('param_uid', UID);

  const apiUrl = new URL('https://huati.weibo.cn/aj/setting/icon/getconfig');
  apiUrl.searchParams.set('type', '1');
  apiUrl.searchParams.set('union_id', 'chao_like');
  apiUrl.searchParams.set('page_id', pageId);
  apiUrl.searchParams.set('param_uid', UID);

  let context;
  let standalone;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: 'chromium',
      headless: true,
      ignoreHTTPSErrors: true,
      proxy: assignment.proxy,
      viewport: { width: 1280, height: 900 }
    });

    const page = context.pages()[0] || await context.newPage();
    const nav = await page.goto(referer.toString(), {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });
    await page.waitForTimeout(800);
    console.log(`[JYZ A/B/C][Browser] 页面 HTTP=${nav?.status() ?? '-'} | finalUrl=${page.url()}`);

    const browserResult = await page.evaluate(async ({ url }) => {
      const response = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        headers: {
          Accept: 'application/json, text/plain, */*',
          'X-Requested-With': 'XMLHttpRequest'
        }
      });
      return {
        status: response.status,
        url: response.url,
        headers: Object.fromEntries(response.headers.entries()),
        text: await response.text(),
        userAgent: navigator.userAgent,
        language: navigator.language
      };
    }, { url: apiUrl.toString() });

    console.log('\n========== A. Browser fetch ==========');
    console.log(`status=${browserResult.status}`);
    console.log(`finalUrl=${browserResult.url}`);
    console.log(`userAgent=${browserResult.userAgent}`);
    console.log(`language=${browserResult.language}`);
    console.log(`headers=${JSON.stringify(selectedHeaders(browserResult.headers))}`);
    console.log(`body=${clip(browserResult.text)}`);

    const cookies = await context.cookies();
    const xsrf = cookies.find(c => c.name === 'XSRF-TOKEN')?.value || '';
    console.log(`\n[JYZ A/B/C] Cookie=${cookies.length} | XSRF=${xsrf ? 'YES' : 'NO'}`);
    console.log(`[JYZ A/B/C] CookieNames=${cookieSummary(cookies)}`);

    const commonHeaders = {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': browserResult.language || 'zh-CN',
      Referer: referer.toString(),
      'X-Requested-With': 'XMLHttpRequest',
      ...(xsrf ? { 'X-XSRF-TOKEN': xsrf } : {})
    };

    const contextRequestResult = await runRequest(
      'B. browserContext.request',
      context.request,
      apiUrl.toString(),
      commonHeaders
    );

    standalone = await request.newContext({
      ignoreHTTPSErrors: true,
      proxy: assignment.proxy,
      userAgent: browserResult.userAgent,
      storageState: { cookies, origins: [] },
      extraHTTPHeaders: commonHeaders
    });

    const standaloneResult = await runRequest(
      'C. standalone request.newContext',
      standalone,
      apiUrl.toString(),
      undefined
    );

    console.log('\n========== 对比结论 ==========' );
    console.log(`A Browser=${browserResult.status}`);
    console.log(`B context.request=${contextRequestResult.status ?? 'ERROR'}`);
    console.log(`C standalone=${standaloneResult.status ?? 'ERROR'}`);

    if (browserResult.status === 200 && contextRequestResult.status === 200 && standaloneResult.status !== 200) {
      console.log('结论：browserContext.request 可用，standalone HTTP 链路有问题。正式脚本应优先改为保留 BrowserContext + context.request。');
    } else if (browserResult.status === 200 && contextRequestResult.status !== 200 && standaloneResult.status !== 200) {
      console.log('结论：Browser fetch 可用，但 Playwright HTTP client 两条链路都异常。正式脚本应保留常驻 Page，用 page.evaluate(fetch)。');
    } else if (browserResult.status === 200 && standaloneResult.status === 200) {
      console.log('结论：standalone HTTP 本次可用；此前 503/timeout 更可能与代理节点或瞬时网络有关。');
    } else {
      console.log('结论：结果混合，请把完整输出发来继续判断。');
    }
  } finally {
    if (standalone) await standalone.dispose().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
})().catch(error => {
  console.error('[JYZ A/B/C] ERROR:', error);
  process.exitCode = 1;
});
