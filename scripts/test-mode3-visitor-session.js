const { chromium } = require('playwright');
const { Pool } = require('pg');
const { buildLightProfileApiUrl, profileTextHasSuperLike } = require('../src/superlike/mode3-profile');

const SAMPLE_SIZE = Math.max(1, Math.min(30, Number(process.env.MODE3_SESSION_TEST_SIZE) || 10));
const TIMEOUT_MS = Number(process.env.SUPERLIKE_LIGHT_REQUEST_TIMEOUT_MS) || 10000;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
  allowExitOnIdle: true
});

function compact(text, max = 220) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function parseMonitorConfig(url) {
  const match = String(url || '').match(/100808([a-f0-9]{32})/i);
  if (!match) throw new Error(`无法从超话URL解析 page_id: ${url}`);
  return {
    pageId: `100808${match[1]}`,
    profileContainerId: `231140${match[1]}_-_profile_inpage`
  };
}

function cookieHeader(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

async function getTestData() {
  const monitorResult = await pool.query(`
    SELECT id, name, url
    FROM monitors
    WHERE COALESCE(enabled, 1) <> 0 AND monitor_type = 'superlike'
    ORDER BY id LIMIT 1
  `);
  if (!monitorResult.rows.length) throw new Error('没有启用的 SuperLike monitor');
  const monitor = monitorResult.rows[0];
  const usersResult = await pool.query(`
    SELECT p.uid, MAX(p.experience_7d) AS experience_7d
    FROM superlike_posts p
    WHERE p.monitor_id = $1
      AND p.uid IS NOT NULL AND p.uid <> ''
      AND CAST(p.first_seen_at AS date) = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date
      AND NOT EXISTS (SELECT 1 FROM superlike_users su WHERE su.uid = p.uid)
    GROUP BY p.uid
    HAVING MAX(p.experience_7d) >= 70
    ORDER BY MAX(p.experience_7d) DESC, MAX(p.id) DESC
    LIMIT $2
  `, [monitor.id, SAMPLE_SIZE]);
  return { monitor, users: usersResult.rows };
}

async function bootstrapVisitorSession() {
  console.log('[SessionTest] 启动无代理 Chromium，仅用于建立微博游客 Session...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
    locale: 'zh-CN'
  });
  const page = await context.newPage();
  try {
    const response = await page.goto('https://m.weibo.cn/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    console.log(`[SessionTest] 首页 status=${response?.status() ?? '-'} | final=${page.url()}`);
    await page.waitForTimeout(2500);

    // 再访问一次首页，让 Visitor 初始化产生的跳转/JS/Cookie 有机会完成。
    if (page.url().includes('visitor.passport.weibo.cn')) {
      console.log('[SessionTest] 首次进入 Visitor System，等待初始化后重新访问 m.weibo.cn...');
      await page.waitForTimeout(2000);
      try {
        await page.goto('https://m.weibo.cn/', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(1500);
      } catch (error) {
        console.log(`[SessionTest] Visitor后二次首页访问异常：${error.message}`);
      }
    }

    const cookies = await context.cookies(['https://m.weibo.cn/', 'https://weibo.cn/', 'https://weibo.com/']);
    console.log(`[SessionTest] Chromium获得 Cookie=${cookies.length} 个 | names=${cookies.map(c => c.name).join(',') || '(none)'}`);
    return {
      cookies,
      cookie: cookieHeader(cookies),
      userAgent: await page.evaluate(() => navigator.userAgent),
      finalUrl: page.url()
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    console.log('[SessionTest] Chromium已关闭；下面全部使用 Node fetch');
  }
}

async function fetchWithSession(config, uid, session) {
  const url = buildLightProfileApiUrl(config, uid);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'User-Agent': session.userAgent,
        Referer: 'https://m.weibo.cn/',
        Cookie: session.cookie
      }
    });
    const text = await response.text();
    const finalUrl = String(response.url || url);
    let json = null;
    try { json = JSON.parse(text); } catch {}
    const ok = response.ok && !finalUrl.includes('visitor.passport.weibo.cn') && Number(json?.ok ?? 0) === 1;
    return {
      ok,
      status: response.status,
      finalUrl,
      apiOk: json?.ok,
      hasSuperLike: ok ? profileTextHasSuperLike(text) : null,
      body: compact(text)
    };
  } catch (error) {
    return { ok: false, status: null, finalUrl: '-', apiOk: null, hasSuperLike: null, body: error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('缺少 DATABASE_URL');
  console.log('================================================');
  console.log('[SessionTest] Mode3：Chromium领游客身份 → 关闭 Chromium → Node fetch');
  console.log(`[SessionTest] 只诊断 ${SAMPLE_SIZE} 个 UID，不更新/删除任何数据库数据`);
  console.log('================================================');

  const { monitor, users } = await getTestData();
  const config = parseMonitorConfig(monitor.url);
  console.log(`[SessionTest] Monitor=${monitor.name} | UID样本=${users.length}`);

  const session = await bootstrapVisitorSession();
  console.log(`[SessionTest] Chromium最终URL=${session.finalUrl}`);
  if (!session.cookie) console.log('[SessionTest] 警告：没有拿到任何 Cookie；仍继续测试，便于确认结果');

  let success = 0;
  for (let i = 0; i < users.length; i++) {
    const uid = String(users[i].uid);
    const result = await fetchWithSession(config, uid, session);
    if (result.ok) success++;
    console.log(`[SessionTest][${i + 1}/${users.length}] UID=${uid} | ${result.ok ? '成功' : '失败'} | status=${result.status ?? '-'} | apiOk=${result.apiOk ?? '-'} | SuperLike=${result.hasSuperLike ?? '-'} | final=${result.finalUrl} | body=${result.body}`);
  }

  console.log('================================================');
  console.log(`[SessionTest] 结果：Node fetch 成功=${success}/${users.length}`);
  if (success > 0) {
    console.log('[SessionTest] 结论：方案②可行。下一步可把 Session 缓存接入正式 Mode3，Session失效时才重新启动 Chromium。');
  } else {
    console.log('[SessionTest] 结论：仅复制 Chromium Cookie 仍不够；下一步比较无痕浏览器 API 请求的完整请求上下文。');
  }
  console.log('================================================');
}

main()
  .catch(error => {
    console.error('[SessionTest] 致命异常：', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await pool.end(); } catch {}
  });
