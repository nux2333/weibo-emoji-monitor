'use strict';

const path = require('path');
const { chromium, request } = require('playwright');
const { parseTopicHomepage } = require('../src/superlike-scanner');
const { db, initDatabase } = require('../src/db');

const TIMEOUT_MS = Number(process.env.MODE4_LOGIN_HTTP_TIMEOUT_MS) || 15000;
const MAX_PAGES = Math.max(1, Number(process.env.MODE4_LOGIN_HTTP_MAX_PAGES) || 20);
const PAGE_DELAY_MS = Math.max(0, Number(process.env.MODE4_LOGIN_HTTP_PAGE_DELAY_MS) || 500);
const USER_DATA_DIR = path.resolve(
  process.env.SUPERLIKE_MODE4_USER_DATA_DIR
  || process.env.SUPERLIKE_BROWSER_USER_DATA_DIR
  || path.join(__dirname, '..', 'data', 'superlike-browser-profile')
);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getMonitor() {
  initDatabase();
  const row = db.prepare(
    "SELECT id, name, url FROM monitors WHERE enabled = 1 AND monitor_type = 'superlike' ORDER BY id LIMIT 1"
  ).get();
  if (!row) throw new Error('没有找到启用中的 SuperLike Monitor');
  return row;
}

function buildUrl(containerId, sinceId = null) {
  const url = new URL('https://m.weibo.cn/api/container/getIndex');
  url.searchParams.set('containerid', containerId);
  url.searchParams.set('title', '超LIKE榜');
  if (sinceId) url.searchParams.set('since_id', String(sinceId));
  return url.toString();
}

function extractUids(json) {
  const result = [];
  for (const card of Array.isArray(json?.data?.cards) ? json.data.cards : []) {
    for (const item of Array.isArray(card?.card_group) ? card.card_group : []) {
      const uid = item?.user?.idstr ?? item?.user?.id;
      if (uid != null) result.push(String(uid));
    }
  }
  return result;
}

function cookiesToHeader(cookies) {
  return cookies
    .filter(item => item && item.name)
    .map(item => `${item.name}=${item.value}`)
    .join('; ');
}

async function main() {
  const monitor = getMonitor();
  const config = parseTopicHomepage(monitor.url);

  console.log('');
  console.log('############################################');
  console.log('# Mode4 登录Cookie → 关闭Chromium → 纯HTTP分页测试');
  console.log('############################################');
  console.log(`Monitor: ${monitor.name}`);
  console.log(`containerid: ${config.chaoLikeListContainerId}`);
  console.log(`Persistent Profile: ${USER_DATA_DIR}`);
  console.log(`测试页数: ${MAX_PAGES}`);

  console.log('');
  console.log('========== 1. 读取 Persistent Profile 登录Cookie ==========');

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: true
  });

  let cookies;
  let userAgent;
  try {
    const page = context.pages()[0] || await context.newPage();
    try {
      await page.goto('https://m.weibo.cn/', {
        waitUntil: 'domcontentloaded',
        timeout: TIMEOUT_MS
      });
      await page.waitForTimeout(1500);
    } catch (error) {
      console.log(`[Cookie读取] m.weibo.cn 打开异常，继续读取已有Cookie | ${error.message}`);
    }

    cookies = await context.cookies([
      'https://m.weibo.cn/',
      'https://weibo.com/'
    ]);

    userAgent = await page.evaluate(() => navigator.userAgent).catch(() =>
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
    );

    console.log(`Cookie数量: ${cookies.length}`);
    console.log(`Cookie名称: ${cookies.map(item => item.name).join(', ') || '-'}`);
  } finally {
    await context.close();
  }

  console.log('[关键] Chromium已完全关闭；下面不再使用 BrowserContext/Page');

  if (!cookies?.length) {
    throw new Error('Persistent Profile 没有读取到 Cookie');
  }

  const cookieHeader = cookiesToHeader(cookies);

  console.log('');
  console.log('========== 2. 使用登录Cookie进行纯HTTP分页 ==========');

  const api = await request.newContext({
    userAgent,
    extraHTTPHeaders: {
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://m.weibo.cn/',
      Cookie: cookieHeader
    }
  });

  let sinceId = null;
  let successPages = 0;
  const uniqueUids = new Set();

  try {
    for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
      const url = buildUrl(config.chaoLikeListContainerId, sinceId);
      const response = await api.get(url, {
        timeout: TIMEOUT_MS,
        failOnStatusCode: false
      });

      const status = response.status();
      const finalUrl = response.url();
      const body = await response.text();

      let json = null;
      try { json = JSON.parse(body); } catch {}

      const uids = extractUids(json);
      uids.forEach(uid => uniqueUids.add(uid));

      const nextSinceId = json?.data?.cardlistInfo?.since_id ?? null;
      const visitor = /visitor\.passport\.weibo\.cn/i.test(finalUrl)
        || /visitor\.passport\.weibo\.cn/i.test(body);
      const loginRequired = /登录|login/i.test(body) && Number(json?.ok ?? 0) !== 1;
      const ok = status === 200
        && Number(json?.ok ?? 0) === 1
        && uids.length > 0
        && !visitor;

      console.log(
        `[HTTP ${pageNo}/${MAX_PAGES}] ` +
        `status=${status} | ok=${json?.ok ?? '非JSON'} | UID=${uids.length} | ` +
        `累计唯一UID=${uniqueUids.size} | since_id=${nextSinceId || '-'} | ` +
        `结果=${ok ? '成功' : '失败'}`
      );

      if (!ok) {
        console.log(`finalUrl=${finalUrl}`);
        console.log(`visitor=${visitor} | loginRequired=${loginRequired}`);
        console.log(`Body预览=${String(body || '').replace(/\s+/g, ' ').slice(0, 600)}`);
        break;
      }

      successPages++;

      if (!nextSinceId) {
        console.log('[HTTP] 没有下一页 since_id，正常结束');
        break;
      }

      sinceId = String(nextSinceId);
      if (PAGE_DELAY_MS > 0) await sleep(PAGE_DELAY_MS);
    }
  } finally {
    await api.dispose();
  }

  console.log('');
  console.log('================ 结论 ================');
  console.log(`成功页数: ${successPages}/${MAX_PAGES}`);
  console.log(`累计唯一UID: ${uniqueUids.size}`);

  if (successPages >= MAX_PAGES) {
    console.log('结果：登录Cookie在 Chromium 关闭后仍可纯HTTP连续分页；Mode4具备改成“登录Cookie + LOCAL + HTTP”的条件。');
  } else if (successPages >= 2) {
    console.log('结果：登录Cookie纯HTTP可以跨过第2页，但需要根据停止页日志判断Cookie寿命/分页限制。');
  } else {
    console.log('结果：仅导出登录Cookie不足以稳定分页；暂时保留现有 Mode4 Persistent Context 架构。');
  }
}

main().catch(error => {
  console.error('[Mode4登录Cookie HTTP测试失败]', error);
  process.exitCode = 1;
});
