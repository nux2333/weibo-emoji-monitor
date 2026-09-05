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
  console.log('# 全新临时 BrowserContext；先访问 m.weibo.cn 自动建立 Visitor Session，不扫码');
  console.log('# Visitor Session 建立后连续测试第1、2、3页');
  console.log('############################################');
  console.log('Monitor: ' + monitor.name);
  console.log('containerid: ' + config.chaoLikeListContainerId);

  const browser = await chromium.launch({ headless:true });
  try {
    const context = await browser.newContext();
    await context.clearCookies();

    console.log('');
    console.log('========== 建立匿名 Visitor Session ==========');

    const page =
      await context.newPage();

    try {
      const response =
        await page.goto(
          'https://m.weibo.cn/',
          {
            waitUntil: 'domcontentloaded',
            timeout: TIMEOUT_MS
          }
        );

      console.log(
        'm.weibo.cn HTTP状态: ' +
        (response ? response.status() : '无Response')
      );

      /*
       * Visitor System 的 JS 可能会自动设置匿名 SUBP/SUB/_T_WM 等
       * visitor cookie，因此给页面一点时间完成跳转/脚本。
       * 不扫码、不输入账号密码。
       */
      await page.waitForTimeout(5000);

      console.log(
        '最终URL: ' +
        page.url()
      );

      const cookies =
        await context.cookies();

      console.log(
        '匿名Cookie数量: ' +
        cookies.length
      );

      if (cookies.length) {
        console.log(
          'Cookie名称: ' +
          cookies
            .map(item => item.name)
            .join(', ')
        );
      }

    } catch (error) {
      console.log(
        '建立Visitor Session异常: ' +
        error.message
      );
    } finally {
      await page.close();
    }

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
      console.log('结果：Visitor Session 下前3页都成功，不需要扫码登录。Mode4 可以继续验证更多分页后改成匿名 Visitor 模式。');
    } else if (results[0]?.ok && results[1] && !results[1].ok) {
      console.log('结果：Visitor Session 下第1页成功、第2页失败，说明后续分页可能确实需要更强登录态。');
    } else if (!results[0]?.ok) {
      console.log('结果：即使先建立 Visitor Session，第1页仍失败；当前环境下 Mode4 不能仅靠普通匿名 Visitor 会话。');
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
