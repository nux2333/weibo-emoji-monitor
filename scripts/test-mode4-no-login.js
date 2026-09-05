const { chromium } = require('playwright');
const { parseTopicHomepage } = require('../src/superlike-scanner');
const { db, initDatabase } = require('../src/db');

const TIMEOUT_MS = Number(process.env.MODE4_NO_LOGIN_TIMEOUT_MS) || 15000;

function getMonitor() {
  initDatabase();
  const row = db.prepare(
    "SELECT id, name, url FROM monitors WHERE url LIKE '%weibo.com/p/100808%' ORDER BY id LIMIT 1"
  ).get();
  if (!row) throw new Error('没有找到 SuperLike 超话 Monitor');
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

async function requestPage(context, containerId, pageNo, sinceId) {
  const url = buildUrl(containerId, sinceId);
  console.log('');
  console.log('========== 匿名测试 第' + pageNo + '页 ==========');
  console.log('since_id=' + (sinceId || '-'));
  console.log(url);

  try {
    const response = await context.request.get(url, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://m.weibo.cn/'
      },
      timeout: TIMEOUT_MS
    });

    const status = response.status();
    const body = await response.text();
    let json = null;
    try { json = JSON.parse(body); } catch {}

    const uids = extractUids(json);
    const nextSinceId = json?.data?.cardlistInfo?.since_id ?? null;

    console.log('HTTP状态: ' + status);
    console.log('API ok: ' + (json?.ok ?? '非JSON'));
    console.log('UID数量: ' + uids.length);
    console.log('下一页 since_id: ' + (nextSinceId || '-'));
    console.log("Set-Cookie: " + (response.headers()['set-cookie'] ? '有' : '无'));
    if (uids.length) console.log('UID预览: ' + uids.slice(0, 5).join(', '));
    if (status !== 200 || Number(json?.ok ?? 0) !== 1) {
      console.log('Body预览: ' + body.replace(/\s+/g, ' ').slice(0, 500));
    }

    return {
      ok: status === 200 && Number(json?.ok ?? 0) === 1 && uids.length > 0,
      status,
      apiOk: json?.ok ?? null,
      uidCount: uids.length,
      nextSinceId: nextSinceId ? String(nextSinceId) : null
    };
  } catch (error) {
    console.log('请求异常: ' + error.message);
    return { ok:false, status:0, apiOk:null, uidCount:0, nextSinceId:null };
  }
}

async function main() {
  const monitor = getMonitor();
  const config = parseTopicHomepage(monitor.url);

  console.log('');
  console.log('############################################');
  console.log('# Mode4 无登录分页测试');
  console.log('# 全新临时 BrowserContext，不使用现有登录 Profile');
  console.log('# 连续测试第1、2、3页');
  console.log('############################################');
  console.log('Monitor: ' + monitor.name);
  console.log('containerid: ' + config.chaoLikeListContainerId);

  const browser = await chromium.launch({ headless:true });
  try {
    const context = await browser.newContext();
    await context.clearCookies();

    let sinceId = null;
    const results = [];

    for (let pageNo = 1; pageNo <= 3; pageNo++) {
      const result = await requestPage(
        context, config.chaoLikeListContainerId, pageNo, sinceId
      );
      results.push(result);
      if (!result.ok || !result.nextSinceId) break;
      sinceId = result.nextSinceId;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log('');
    console.log('================ 结论 ================');
    results.forEach((r, i) => {
      console.log(
        '第' + (i + 1) + '页: ' + (r.ok ? '匿名成功' : '匿名失败') +
        ' | HTTP=' + r.status + ' | ok=' + (r.apiOk ?? '-') +
        ' | UID=' + r.uidCount
      );
    });

    if (results.length >= 3 && results.every(item => item.ok)) {
      console.log('结果：前3页都不需要扫码登录。Mode4 很可能可以改成匿名请求。');
    } else if (results[0]?.ok && results[1] && !results[1].ok) {
      console.log('结果：第1页匿名成功、第2页匿名失败，符合“分页开始需要登录/额外会话”的猜测。');
    } else if (!results[0]?.ok) {
      console.log('结果：第1页匿名请求本身就失败；当前网络/IP/Visitor限制下不能认为第一页免登录。');
    } else {
      console.log('结果：出现中途失败，请根据上面的 HTTP/API ok/Body 进一步判断。');
    }
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error('[Mode4无登录测试失败]', error);
  process.exitCode = 1;
});
