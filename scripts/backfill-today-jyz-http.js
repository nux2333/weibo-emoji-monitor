'use strict';

const path = require('path');
const { chromium, request } = require('playwright');
const {
  createBatchLogger
} = require('../src/batch-logger');
const {
  ProxyPool
} = require('../src/proxy-pool');
const {
  db,
  initDatabase,
  saveSuperLikeUser
} = require('../src/db');
const {
  deletePostsByUidWithLog
} = require('../src/superlike/post-save');

const batchLogger =
  createBatchLogger(
    'backfill-today-jyz'
  );

const ROOT =
  path.join(
    __dirname,
    '..'
  );

const TOPIC_HASH =
  process.env.WEIBO_TOPIC_HASH
  || 'f1d33f71dff693a2708cb3e8ef584a44';

const JYZ_SERVICE_URL =
  process.env.WEIBO_JYZ_SERVICE_URL
  || 'http://127.0.0.1:3011/jyz';

const JYZ_PROFILE_DIR =
  process.env.WEIBO_JYZ_PROFILE
    ? path.resolve(process.env.WEIBO_JYZ_PROFILE)
    : path.join(
        ROOT,
        'data',
        'superlike-browser-profile-jyz'
      );

const USE_PROXY =
  process.env.JYZ_BACKFILL_USE_PROXY !== '0';

const PROXY_POOL =
  new ProxyPool({
    filePath:
      process.env.WEIBO_GOOD_PROXY_FILE
      || path.join(
        ROOT,
        'data',
        'weibo-good-proxies.txt'
      ),
    rawPool:
      process.env.JYZ_BACKFILL_PROXY_POOL
      || '',
    fallback:
      process.env.JYZ_BACKFILL_PROXY
      || process.env.WEIBO_PROXY
      || '',
    cooldownMs:
      Number(
        process.env.JYZ_BACKFILL_PROXY_COOLDOWN_MS
      )
      || 30 * 60 * 1000,
    name:
      'jyz-backfill'
  });

const BATCH_SIZE =
  Number(process.env.JYZ_BACKFILL_BATCH_SIZE)
  || 100;

const REST_MS =
  Number(process.env.JYZ_BACKFILL_REST_MS)
  || 60 * 1000;

const IDLE_WAIT_MS =
  Number(process.env.JYZ_BACKFILL_IDLE_WAIT_MS)
  || 60 * 1000;

const HIGH_SCORE_REFRESH_MIN =
  Number(process.env.JYZ_HIGH_SCORE_REFRESH_MIN)
  || 70;

const HIGH_SCORE_REFRESH_BATCH_SIZE =
  Number(process.env.JYZ_HIGH_SCORE_REFRESH_BATCH_SIZE)
  || 100;

const REQUEST_DELAY_MS =
  Number(process.env.JYZ_BACKFILL_REQUEST_DELAY_MS)
  || 300;

const HTTP_TIMEOUT_MS =
  Number(process.env.JYZ_HTTP_TIMEOUT_MS)
  || 12000;

const MAX_PROXY_ATTEMPTS =
  Math.max(
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
  if (!text) {
    return null;
  }

  const match =
    text.match(/经验值\s*[：:]\s*(\d+)/)
    || text.match(/(\d+)\s*$/);

  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  return Number.isFinite(value)
    ? value
    : null;
}

function buildUrls(uid) {
  const pageId =
    '100808' + TOPIC_HASH;

  const referer =
    new URL(
      'https://huati.weibo.cn/super/setting/icon'
    );

  referer.searchParams.set('page_id', pageId);
  referer.searchParams.set('icon_type', '1');
  referer.searchParams.set('union_id', 'chao_like');
  referer.searchParams.set('param_uid', String(uid));

  const apiUrl =
    new URL(
      'https://huati.weibo.cn/aj/setting/icon/getconfig'
    );

  apiUrl.searchParams.set('type', '1');
  apiUrl.searchParams.set('union_id', 'chao_like');
  apiUrl.searchParams.set('page_id', pageId);
  apiUrl.searchParams.set('param_uid', String(uid));

  return {
    referer: referer.toString(),
    apiUrl: apiUrl.toString()
  };
}

function isProxyConnectionError(message) {
  const text = String(message || '');
  return (
    /ERR_TUNNEL_CONNECTION_FAILED/i.test(text)
    || /ERR_PROXY_CONNECTION_FAILED/i.test(text)
    || /ERR_SOCKS_CONNECTION_FAILED/i.test(text)
    || /ERR_CONNECTION_RESET/i.test(text)
    || /ERR_CONNECTION_CLOSED/i.test(text)
    || /ERR_CONNECTION_REFUSED/i.test(text)
    || /ERR_TIMED_OUT/i.test(text)
    || /ERR_EMPTY_RESPONSE/i.test(text)
    || /ERR_CERT_AUTHORITY_INVALID/i.test(text)
    || /ERR_CERT_COMMON_NAME_INVALID/i.test(text)
    || /ERR_CERT_DATE_INVALID/i.test(text)
    || /Failed to fetch/i.test(text)
    || /NetworkError/i.test(text)
    || /fetch failed/i.test(text)
    || /Timeout/i.test(text)
    || /AbortError/i.test(text)
    || /ECONN/i.test(text)
    || /proxy/i.test(text)
  );
}

async function queryJyzService(uid) {
  try {
    const url = new URL(JYZ_SERVICE_URL);
    url.searchParams.set('topicHash', TOPIC_HASH);
    url.searchParams.set('uid', String(uid));

    const response =
      await fetch(
        url.toString(),
        {
          signal: AbortSignal.timeout(15000)
        }
      );

    const json =
      await response.json().catch(() => null);

    if (
      json?.ok
      && Number.isFinite(Number(json.experience7d))
    ) {
      return {
        ok: true,
        experience7d: Number(json.experience7d),
        currentInfo: json.currentInfo || '',
        source: 'service'
      };
    }

    return {
      ok: false,
      message:
        json?.message
        || ('HTTP ' + response.status)
    };
  } catch (error) {
    return {
      ok: false,
      unavailable: true,
      message: error?.message || String(error)
    };
  }
}

async function acquireBackfillProxy() {
  if (!USE_PROXY) {
    return {
      configured: false,
      raw: null,
      proxy: null,
      masked: 'LOCAL'
    };
  }

  while (true) {
    const assignment =
      await PROXY_POOL.acquire();

    if (
      assignment?.proxy
      && !assignment.allCoolingDown
    ) {
      return assignment;
    }

    if (
      assignment?.allCoolingDown
      && Number.isFinite(Number(assignment.nextReadyAt))
    ) {
      const waitMs =
        Math.max(
          1000,
          Number(assignment.nextReadyAt) - Date.now()
        );

      console.log(
        '[JYZ补数][代理] 全部代理冷却中，等待 '
        + Math.ceil(waitMs / 1000)
        + ' 秒...'
      );

      await sleep(waitMs);
      continue;
    }

    console.log(
      '[JYZ补数][代理] 健康代理池为空，暂时使用本地IP。'
    );

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

async function rotateBackfillProxy(reason, remove = false) {
  if (currentProxyAssignment?.raw) {
    if (remove) {
      PROXY_POOL.remove(currentProxyAssignment.raw);
    } else {
      PROXY_POOL.markBlocked(currentProxyAssignment.raw);
    }

    console.log(
      '[JYZ补数][代理] 当前代理 '
      + currentProxyAssignment.masked
      + ' 因 '
      + reason
      + (remove ? ' 已移除' : ' 已进入冷却')
    );
  }

  await closeHttpContext();
  currentProxyAssignment = null;
}

async function bootstrapHttpSession(uid) {
  if (httpContext) {
    return {
      ok: true,
      context: httpContext
    };
  }

  if (creatingSession) {
    return creatingSession;
  }

  creatingSession = (async () => {
    if (!currentProxyAssignment) {
      currentProxyAssignment =
        await acquireBackfillProxy();
    }

    const urls = buildUrls(uid);
    let browserContext = null;

    try {
      console.log(
        '[JYZ补数][HTTP Session] Chromium仅初始化登录态'
        + ' | UID=' + uid
        + ' | Proxy=' + (currentProxyAssignment?.masked || 'LOCAL')
      );

      browserContext =
        await chromium.launchPersistentContext(
          JYZ_PROFILE_DIR,
          {
            channel: 'chromium',
            headless: true,
            ignoreHTTPSErrors: true,
            ...(currentProxyAssignment?.proxy
              ? { proxy: currentProxyAssignment.proxy }
              : {}),
            viewport: {
              width: 1280,
              height: 900
            }
          }
        );

      const pages = browserContext.pages();
      const page =
        pages[0]
        || await browserContext.newPage();

      const response =
        await page.goto(
          urls.referer,
          {
            waitUntil: 'domcontentloaded',
            timeout: 15000
          }
        );

      await sleep(500);

      const finalUrl = page.url();

      if (
        /passport\.weibo\.(cn|com)/i.test(finalUrl)
        || /login/i.test(finalUrl)
      ) {
        return {
          ok: false,
          message:
            'JYZ profile未登录huati：' + finalUrl
        };
      }

      const cookies =
        await browserContext.cookies();

      const huatiCookies =
        cookies.filter(cookie =>
          String(cookie?.domain || '')
            .includes('weibo.cn')
        );

      console.log(
        '[JYZ补数][HTTP Session] 登录态初始化完成'
        + ' | HTTP=' + (response?.status?.() ?? '-')
        + ' | Cookie=' + cookies.length
        + ' | weibo.cn=' + huatiCookies.length
      );

      const independent =
        await request.newContext({
          ...(currentProxyAssignment?.proxy
            ? { proxy: currentProxyAssignment.proxy }
            : {}),
          storageState: {
            cookies,
            origins: []
          },
          extraHTTPHeaders: {
            Accept:
              'application/json, text/plain, */*',
            'X-Requested-With':
              'XMLHttpRequest'
          },
          ignoreHTTPSErrors: true
        });

      httpContext = independent;

      await browserContext.close();
      browserContext = null;

      console.log(
        '[JYZ补数][HTTP Session] Chromium已关闭；后续经验值查询全部走HTTP。'
      );

      return {
        ok: true,
        context: independent
      };

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

async function queryJyzHttp(uid) {
  const bootstrap =
    await bootstrapHttpSession(uid);

  if (!bootstrap.ok) {
    return bootstrap;
  }

  const urls = buildUrls(uid);
  const startedAt = Date.now();

  try {
    const response =
      await bootstrap.context.get(
        urls.apiUrl,
        {
          headers: {
            Accept:
              'application/json, text/plain, */*',
            'X-Requested-With':
              'XMLHttpRequest',
            Referer: urls.referer
          },
          timeout: HTTP_TIMEOUT_MS,
          failOnStatusCode: false
        }
      );

    const text =
      await response.text();

    const status =
      response.status();

    console.log(
      '[JYZ补数][HTTP] UID=' + uid
      + ' | HTTP=' + status
      + ' | ' + (Date.now() - startedAt) + 'ms'
    );

    if (
      status === 403
      || status === 418
      || status === 432
    ) {
      return {
        ok: false,
        status,
        message: 'HTTP ' + status
      };
    }

    if (
      status < 200
      || status >= 300
    ) {
      return {
        ok: false,
        status,
        message: 'HTTP ' + status
      };
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
        message:
          'JSON解析失败：' + error.message
      };
    }

    if (Number(json?.code) !== 100000) {
      return {
        ok: false,
        status:
          Number(json?.code) === 418
            ? 418
            : null,
        message:
          'API code=' + (json?.code ?? '-')
          + ' msg=' + (json?.msg || '-')
      };
    }

    const currentInfo =
      json?.data?.current_info
      || '';

    const experience7d =
      extractExperience7d(currentInfo);

    if (experience7d === null) {
      return {
        ok: false,
        message:
          'current_info没有可解析经验值'
      };
    }

    return {
      ok: true,
      experience7d,
      currentInfo,
      source: 'http-session'
    };

  } catch (error) {
    return {
      ok: false,
      message: error?.message || String(error)
    };
  }
}

async function queryJyz(uid) {
  if (!USE_PROXY) {
    const serviceResult =
      await queryJyzService(uid);

    if (serviceResult.ok) {
      return serviceResult;
    }

    if (!serviceResult.unavailable) {
      return serviceResult;
    }
  }

  let lastResult = null;

  for (
    let attempt = 1;
    attempt <= MAX_PROXY_ATTEMPTS;
    attempt++
  ) {
    const result =
      await queryJyzHttp(uid);

    lastResult = result;

    if (result.ok) {
      return result;
    }

    if (
      Number(result.status) === 418
      || Number(result.status) === 403
      || Number(result.status) === 432
      || result.sessionInvalid
    ) {
      await rotateBackfillProxy(
        result.message || 'session blocked',
        false
      );

      console.log(
        '[JYZ补数][重试] UID=' + uid
        + ' | ' + (result.message || 'session blocked')
        + ' → 换代理并重新初始化HTTP session'
        + ' | ' + attempt + '/' + MAX_PROXY_ATTEMPTS
      );

      continue;
    }

    if (isProxyConnectionError(result.message)) {
      await rotateBackfillProxy(
        result.message || '代理连接失败',
        true
      );

      console.log(
        '[JYZ补数][重试] UID=' + uid
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

(async () => {
  initDatabase();

  const updateStmt =
    db.prepare(`
      UPDATE superlike_posts
      SET
        experience_7d = ?,
        initial_experience_7d =
          COALESCE(initial_experience_7d, ?),
        profile_status =
          CASE
            WHEN profile_status = 'PROFILE_FAILED'
            THEN 'NO_SUPERLIKE'
            ELSE profile_status
          END
      WHERE id = ?
        AND experience_7d IS NULL
    `);

  const updateUidExperienceStmt =
    db.prepare(`
      UPDATE superlike_posts
      SET
        experience_7d = ?,
        profile_status =
          CASE
            WHEN profile_status = 'PROFILE_FAILED'
            THEN 'NO_SUPERLIKE'
            ELSE profile_status
          END
      WHERE uid = ?
    `);

  const selectHighScoreRefreshStmt =
    db.prepare(`
      SELECT
        monitor_id,
        uid,
        MAX(username) AS username,
        MIN(experience_7d) AS experience_7d,
        MAX(post_created_at) AS latest_post_created_at,
        COUNT(*) AS post_count
      FROM superlike_posts
      WHERE uid IS NOT NULL
        AND TRIM(uid) <> ''
        AND experience_7d >= ?
        AND experience_7d < 80
        AND date(
          datetime(post_created_at)
        ) = date(
          'now',
          '+8 hours'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM superlike_users su
          WHERE su.uid = superlike_posts.uid
        )
      GROUP BY
        monitor_id,
        uid
      ORDER BY
        MIN(experience_7d) ASC,
        datetime(MAX(post_created_at)) DESC,
        uid ASC
      LIMIT ?
    `);

  const selectBatchStmt =
    db.prepare(`
      SELECT
        id,
        monitor_id,
        uid,
        username,
        post_id,
        post_created_at,
        first_seen_at
      FROM superlike_posts
      WHERE experience_7d IS NULL
      ORDER BY
        CASE
          WHEN post_created_at IS NULL
            OR TRIM(post_created_at) = ''
          THEN 1
          ELSE 0
        END ASC,
        datetime(post_created_at) DESC,
        id DESC
      LIMIT ?
    `);

  let round = 0;
  let totalProcessed = 0;
  let totalUpdated = 0;
  let totalFailed = 0;
  let totalPromoted = 0;
  let totalDeletedPosts = 0;
  let totalHighScoreRefreshed = 0;
  let totalHighScoreChanged = 0;

  const promotedUids = new Set();

  console.log('');
  console.log('==============================================');
  console.log('# JYZ 全库空值补数（24小时常驻）');
  console.log('# 网络：Chromium仅初始化huati登录Cookie；之后经验值API全部HTTP');
  console.log('# 任务1：全库 experience_7d IS NULL 补数');
  console.log(
    '# 任务2：当天发帖且 experience_7d >= '
    + HIGH_SCORE_REFRESH_MIN
    + ' 且 <80，按经验值低→高刷新最新经验值'
  );
  console.log('# 顺序：post_created_at 新 → 旧，时间为空时按 id DESC 兜底');
  console.log('# 每轮最多：' + BATCH_SIZE + ' 条');
  console.log(
    '# 规则：经验值 >= 80 -> 写入 superlike_users，并删除该UID全部 superlike_posts'
  );
  console.log('==============================================');
  console.log('');

  while (true) {
    const highScoreRows =
      selectHighScoreRefreshStmt.all(
        HIGH_SCORE_REFRESH_MIN,
        HIGH_SCORE_REFRESH_BATCH_SIZE
      );

    if (highScoreRows.length > 0) {
      console.log('');
      console.log('========== JYZ 当天高分刷新 ==========');
      console.log(
        '[JYZ高分刷新] 本轮 UID='
        + highScoreRows.length
        + ' | 范围=' + HIGH_SCORE_REFRESH_MIN
        + '~79 | 顺序=经验值低→高'
      );

      for (
        let highIndex = 0;
        highIndex < highScoreRows.length;
        highIndex++
      ) {
        const row = highScoreRows[highIndex];
        const normalizedUid =
          String(row.uid || '').trim();

        if (
          !normalizedUid
          || promotedUids.has(normalizedUid)
        ) {
          continue;
        }

        const oldExperience = Number(row.experience_7d);

        console.log(
          '[JYZ高分刷新] ' + (highIndex + 1)
          + '/' + highScoreRows.length
          + ' | UID=' + normalizedUid
          + ' | 当前=' + oldExperience
          + ' | 当天最新发帖=' + (row.latest_post_created_at || '-')
          + ' | 候选帖=' + Number(row.post_count || 0)
        );

        const result = await queryJyz(normalizedUid);

        if (
          result.ok
          && Number.isFinite(Number(result.experience7d))
        ) {
          const latestExperience = Number(result.experience7d);
          totalHighScoreRefreshed++;

          if (latestExperience >= 80) {
            const userInserted =
              saveSuperLikeUser(
                Number(row.monitor_id),
                normalizedUid,
                null,
                latestExperience
              );

            const deletedPosts =
              deletePostsByUidWithLog(
                normalizedUid,
                'EXPERIENCE_7D_GTE_80'
              );

            promotedUids.add(normalizedUid);
            totalPromoted++;
            totalDeletedPosts += deletedPosts;

            console.log(
              '[JYZ高分刷新][>=80→超LIKE] UID=' + normalizedUid
              + ' | ' + oldExperience + '→' + latestExperience
              + ' | superlike_users='
              + (userInserted ? '新增' : '已存在/更新')
              + ' | 删除帖子=' + deletedPosts
              + ' | 来源=' + (result.source || '-')
            );
          } else {
            const changes =
              updateUidExperienceStmt.run(
                latestExperience,
                normalizedUid
              ).changes || 0;

            if (latestExperience !== oldExperience) {
              totalHighScoreChanged++;
            }

            console.log(
              '[JYZ高分刷新][更新] UID=' + normalizedUid
              + ' | ' + oldExperience + '→' + latestExperience
              + ' | 同UID更新帖子=' + changes
              + ' | 来源=' + (result.source || '-')
            );
          }
        } else {
          totalFailed++;
          console.log(
            '[JYZ高分刷新][失败] UID=' + normalizedUid
            + ' | 当前=' + oldExperience
            + ' | ' + (result.message || 'unknown')
          );
        }

        if (
          REQUEST_DELAY_MS > 0
          && highIndex < highScoreRows.length - 1
        ) {
          await sleep(REQUEST_DELAY_MS);
        }
      }
    }

    const rows = selectBatchStmt.all(BATCH_SIZE);

    if (rows.length === 0) {
      console.log('');
      console.log('========== JYZ 当前无待补数据 ==========');
      console.log(
        '累计处理：' + totalProcessed
        + ' | 更新：' + totalUpdated
        + ' | >=80加入超LIKE：' + totalPromoted
        + ' | 删除帖子：' + totalDeletedPosts
        + ' | 高分刷新：' + totalHighScoreRefreshed
        + ' | 高分变更：' + totalHighScoreChanged
        + ' | 失败：' + totalFailed
      );
      console.log(
        '[JYZ补数] '
        + Math.round(IDLE_WAIT_MS / 1000)
        + ' 秒后重新检查新入库数据。'
      );

      await sleep(IDLE_WAIT_MS);
      continue;
    }

    round++;

    console.log('');
    console.log('========== JYZ 第 ' + round + ' 轮 ==========');
    console.log('[JYZ补数] 本轮取最新空值 ' + rows.length + ' 条');

    let roundUpdated = 0;
    let roundFailed = 0;
    let roundPromoted = 0;
    let roundDeletedPosts = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const normalizedUid =
        String(row.uid || '').trim();

      if (
        normalizedUid
        && promotedUids.has(normalizedUid)
      ) {
        console.log(
          '[JYZ补数][跳过] UID=' + normalizedUid
          + ' | 本轮已因经验值>=80加入超LIKE并删除全部帖子'
        );
        continue;
      }

      totalProcessed++;

      console.log(
        '[JYZ补数] ' + (i + 1) + '/' + rows.length
        + ' | UID=' + row.uid
        + ' | Post=' + row.post_id
        + ' | 发帖=' + (row.post_created_at || '-')
        + ' | first_seen_at=' + (row.first_seen_at || '-')
      );

      const result = await queryJyz(row.uid);

      if (
        result.ok
        && Number.isFinite(Number(result.experience7d))
      ) {
        const experience7d = Number(result.experience7d);

        if (experience7d >= 80) {
          const userInserted =
            saveSuperLikeUser(
              Number(row.monitor_id),
              normalizedUid,
              null,
              experience7d
            );

          const deletedPosts =
            deletePostsByUidWithLog(
              normalizedUid,
              'EXPERIENCE_7D_GTE_80'
            );

          promotedUids.add(normalizedUid);
          roundPromoted++;
          totalPromoted++;
          roundDeletedPosts += deletedPosts;
          totalDeletedPosts += deletedPosts;

          console.log(
            '[JYZ补数][经验值>=80→超LIKE] UID=' + normalizedUid
            + ' | jyz=' + experience7d
            + ' | superlike_users='
            + (userInserted ? '新增' : '已存在/更新')
            + ' | 删除帖子=' + deletedPosts
            + ' | 来源=' + (result.source || '-')
          );
        } else {
          const changes =
            updateStmt.run(
              experience7d,
              experience7d,
              Number(row.id)
            ).changes || 0;

          if (changes > 0) {
            roundUpdated++;
            totalUpdated++;
            console.log(
              '[JYZ补数][更新] UID=' + row.uid
              + ' | jyz=' + experience7d
              + ' | 来源=' + (result.source || '-')
              + ' | 本轮更新=' + roundUpdated
              + ' | 总更新=' + totalUpdated
            );
          } else {
            console.log(
              '[JYZ补数][跳过] UID=' + row.uid
              + ' | 记录可能已被其他进程更新'
            );
          }
        }
      } else {
        roundFailed++;
        totalFailed++;
        console.log(
          '[JYZ补数][失败] UID=' + row.uid
          + ' | ' + (result.message || 'unknown')
        );
      }

      if (
        REQUEST_DELAY_MS > 0
        && i < rows.length - 1
      ) {
        await sleep(REQUEST_DELAY_MS);
      }
    }

    console.log(
      '[JYZ补数][本轮完成] 处理=' + rows.length
      + ' | 更新=' + roundUpdated
      + ' | >=80加入超LIKE=' + roundPromoted
      + ' | 删除帖子=' + roundDeletedPosts
      + ' | 失败=' + roundFailed
    );

    console.log(
      '[JYZ补数] 休息 '
      + Math.round(REST_MS / 1000)
      + ' 秒；之后先刷新当天高分UID，再补全库空值。'
    );

    await sleep(REST_MS);
  }
})()
  .catch(
    async error => {
      console.error(
        '[JYZ补数] 异常：',
        error
      );

      await closeHttpContext();
      await batchLogger.close().catch(() => {});
      process.exitCode = 1;
    }
  );
