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
  name: 'jyz-ab-test'
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

(async () => {
  console.log('==============================================');
  console.log(`[JYZ A/B] UID=${UID}`);
  console.log('目的：同代理、同Cookie、同URL比较 Browser fetch 与 APIRequestContext');
  console.log('==============================================');

  const assignment = await pool.acquire();
  if (!assignment?.proxy) throw new Error('没有可用健康代理');
  console.log(`[JYZ A/B] Proxy=${assignment.masked}`);

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
  let api;
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
    console.log(`[JYZ A/B][Browser] 页面 HTTP=${nav?.status() ?? '-'} | finalUrl=${page.url()}`);

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
    console.log(`\n[JYZ A/B] Cookie=${cookies.length} | XSRF=${xsrf ? 'YES' : 'NO'}`);
    console.log(`[JYZ A/B] CookieNames=${cookieSummary(cookies)}`);

    api = await request.newContext({
      ignoreHTTPSErrors: true,
      proxy: assignment.proxy,
      userAgent: browserResult.userAgent,
      extraHTTPHeaders: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': browserResult.language || 'zh-CN',
        Referer: referer.toString(),
        'X-Requested-With': 'XMLHttpRequest',
        ...(xsrf ? { 'X-XSRF-TOKEN': xsrf } : {})
      }
    });
    await api.storageState({ path: undefined }).catch(() => null);
    await api.dispose();

    api = await request.newContext({
      ignoreHTTPSErrors: true,
      proxy: assignment.proxy,
      userAgent: browserResult.userAgent,
      storageState: { cookies, origins: [] },
      extraHTTPHeaders: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': browserResult.language || 'zh-CN',
        Referer: referer.toString(),
        'X-Requested-With': 'XMLHttpRequest',
        ...(xsrf ? { 'X-XSRF-TOKEN': xsrf } : {})
      }
    });

    const httpResponse = await api.get(apiUrl.toString(), { timeout: 15000 });
    const httpText = await httpResponse.text();

    console.log('\n========== B. APIRequestContext ==========');
    console.log(`status=${httpResponse.status()}`);
    console.log(`finalUrl=${httpResponse.url()}`);
    console.log(`headers=${JSON.stringify(selectedHeaders(httpResponse.headers()))}`);
    console.log(`body=${clip(httpText)}`);

    console.log('\n========== 对比结论 ==========');
    if (browserResult.status === 200 && httpResponse.status() !== 200) {
      console.log(`Browser=200 / HTTP=${httpResponse.status()}：HTTP请求仍缺浏览器特征，重点比较响应body/header。`);
    } else if (browserResult.status === httpResponse.status()) {
      console.log(`两边status相同=${browserResult.status}：更像服务端/代理当时状态，而不是单纯APIRequestContext差异。`);
    } else {
      console.log(`Browser=${browserResult.status} / HTTP=${httpResponse.status()}：存在明确链路差异。`);
    }
  } finally {
    if (api) await api.dispose().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
})().catch(error => {
  console.error('[JYZ A/B] ERROR:', error);
  process.exitCode = 1;
});
