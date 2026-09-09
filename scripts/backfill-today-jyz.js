const path = require('path');
const { chromium } = require('playwright');
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
    ? path.resolve(
        process.env.WEIBO_JYZ_PROFILE
      )
    : path.join(
        ROOT,
        'data',
        'superlike-browser-profile-scan'
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
  Number(
    process.env.JYZ_BACKFILL_BATCH_SIZE
  )
  || 100;

const REST_MS =
  Number(
    process.env.JYZ_BACKFILL_REST_MS
  )
  || 60 * 1000;

const REQUEST_DELAY_MS =
  Number(
    process.env.JYZ_BACKFILL_REQUEST_DELAY_MS
  )
  || 300;

let localContext = null;
let currentProxyAssignment = null;

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

function extractExperience7d(
  currentInfo
) {
  const text =
    String(
      currentInfo
      || ''
    ).trim();

  if (!text) {
    return null;
  }

  const match =
    text.match(
      /经验值\s*[：:]\s*(\d+)/
    )
    ||
    text.match(
      /(\d+)\s*$/
    );

  if (!match) {
    return null;
  }

  const value =
    Number(
      match[1]
    );

  return Number.isFinite(
    value
  )
    ? value
    : null;
}

async function queryJyzService(
  uid
) {
  try {
    const url =
      new URL(
        JYZ_SERVICE_URL
      );

    url.searchParams.set(
      'topicHash',
      TOPIC_HASH
    );

    url.searchParams.set(
      'uid',
      String(uid)
    );

    const response =
      await fetch(
        url.toString(),
        {
          signal:
            AbortSignal.timeout(
              15000
            )
        }
      );

    const json =
      await response
        .json()
        .catch(
          () => null
        );

    if (
      json?.ok
      &&
      Number.isFinite(
        Number(
          json.experience7d
        )
      )
    ) {
      return {
        ok: true,
        experience7d:
          Number(
            json.experience7d
          ),
        currentInfo:
          json.currentInfo
          || '',
        source:
          'service'
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
      message:
        error?.message
        || String(error)
    };
  }
}

function isProxyConnectionError(
  message
) {
  return (
    /ERR_TUNNEL_CONNECTION_FAILED/i.test(message)
    ||
    /ERR_PROXY_CONNECTION_FAILED/i.test(message)
    ||
    /ERR_SOCKS_CONNECTION_FAILED/i.test(message)
    ||
    /ERR_CONNECTION_RESET/i.test(message)
    ||
    /ERR_CONNECTION_CLOSED/i.test(message)
    ||
    /ERR_CONNECTION_REFUSED/i.test(message)
    ||
    /ERR_TIMED_OUT/i.test(message)
    ||
    /proxy/i.test(message)
  );
}

async function closeLocalContext() {
  if (localContext) {
    try {
      await localContext.close();
    } catch {
      // ignore
    }

    localContext = null;
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
      &&
      !assignment.allCoolingDown
    ) {
      return assignment;
    }

    if (
      assignment?.allCoolingDown
      &&
      Number.isFinite(
        Number(
          assignment.nextReadyAt
        )
      )
    ) {
      const waitMs =
        Math.max(
          1000,
          Number(
            assignment.nextReadyAt
          )
          - Date.now()
        );

      console.log(
        '[JYZ补数][代理] 全部代理冷却中，等待 '
        + Math.ceil(
            waitMs / 1000
          )
        + ' 秒...'
      );

      await sleep(
        waitMs
      );

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

async function rotateBackfillProxy(
  reason,
  remove = false
) {
  if (
    currentProxyAssignment?.raw
  ) {
    if (remove) {
      PROXY_POOL.remove(
        currentProxyAssignment.raw
      );
    } else {
      PROXY_POOL.markBlocked(
        currentProxyAssignment.raw
      );
    }

    console.log(
      '[JYZ补数][代理] 当前代理 '
      + currentProxyAssignment.masked
      + ' 因 '
      + reason
      + (
        remove
          ? ' 已移除'
          : ' 已进入冷却'
      )
    );
  }

  await closeLocalContext();

  currentProxyAssignment =
    null;
}

async function ensureLocalContext() {
  if (localContext) {
    return localContext;
  }

  if (
    !currentProxyAssignment
  ) {
    currentProxyAssignment =
      await acquireBackfillProxy();
  }

  console.log(
    '[JYZ补数] 启动老主浏览器 persistent profile'
    + (
      currentProxyAssignment?.proxy
        ? ' | 代理='
          + currentProxyAssignment.masked
        : ' | 本地IP'
    )
  );

  localContext =
    await chromium
      .launchPersistentContext(
        JYZ_PROFILE_DIR,
        {
          headless:
            process.env.JYZ_BACKFILL_HEADLESS
            !== '0',

          ...(
            currentProxyAssignment?.proxy
              ? {
                  proxy:
                    currentProxyAssignment.proxy
                }
              : {}
          ),

          viewport: {
            width: 1280,
            height: 900
          }
        }
      );

  return localContext;
}

async function queryJyzLocal(
  uid
) {
  const context =
    await ensureLocalContext();

  let page = null;

  try {
    const pageId =
      '100808'
      + TOPIC_HASH;

    const referer =
      new URL(
        'https://huati.weibo.cn/super/setting/icon'
      );

    referer.searchParams.set(
      'page_id',
      pageId
    );

    referer.searchParams.set(
      'icon_type',
      '1'
    );

    referer.searchParams.set(
      'union_id',
      'chao_like'
    );

    referer.searchParams.set(
      'param_uid',
      String(uid)
    );

    const apiUrl =
      new URL(
        'https://huati.weibo.cn/aj/setting/icon/getconfig'
      );

    apiUrl.searchParams.set(
      'type',
      '1'
    );

    apiUrl.searchParams.set(
      'union_id',
      'chao_like'
    );

    apiUrl.searchParams.set(
      'page_id',
      pageId
    );

    apiUrl.searchParams.set(
      'param_uid',
      String(uid)
    );

    page =
      await context.newPage();

    await page.goto(
      referer.toString(),
      {
        waitUntil:
          'domcontentloaded',
        timeout:
          15000
      }
    )
      .catch(
        () => null
      );

    await page.waitForTimeout(
      300
    );

    const finalUrl =
      page.url();

    if (
      /passport\.weibo\.(cn|com)/i
        .test(
          finalUrl
        )
      ||
      /login/i.test(
        finalUrl
      )
    ) {
      return {
        ok: false,
        message:
          'JYZ profile未登录huati：'
          + finalUrl
      };
    }

    let result = null;

    for (
      let evaluateAttempt = 1;
      evaluateAttempt <= 2;
      evaluateAttempt++
    ) {
      try {
        result =
          await page.evaluate(
            async url => {
              try {
                const response =
                  await fetch(
                    url,
                    {
                      credentials:
                        'include',
                      cache:
                        'no-store',
                      headers: {
                        Accept:
                          'application/json, text/plain, */*',
                        'X-Requested-With':
                          'XMLHttpRequest'
                      }
                    }
                  );

                return {
                  status:
                    response.status,
                  text:
                    await response.text()
                };
              } catch (error) {
                return {
                  status: null,
                  text: '',
                  error:
                    error?.message
                    || String(error)
                };
              }
            },
            apiUrl.toString()
          );

        break;

      } catch (error) {
        const message =
          error?.message
          || String(error);

        if (
          /Execution context was destroyed/i.test(
            message
          )
          ||
          /Cannot find context with specified id/i.test(
            message
          )
        ) {
          console.log(
            '[JYZ补数][页面重试] UID='
            + uid
            + ' | 页面执行上下文失效，重新打开huati页面 | '
            + evaluateAttempt
            + '/2'
          );

          if (
            page
            &&
            !page.isClosed()
          ) {
            await page.close()
              .catch(
                () => {}
              );
          }

          page =
            await context.newPage();

          await page.goto(
            referer.toString(),
            {
              waitUntil:
                'domcontentloaded',
              timeout:
                15000
            }
          )
            .catch(
              () => null
            );

          await page.waitForTimeout(
            500
          );

          if (
            evaluateAttempt < 2
          ) {
            continue;
          }
        }

        throw error;
      }
    }

    if (
      !result
      ||
      result.error
    ) {
      return {
        ok: false,
        message:
          result?.error
          || '页面内fetch失败'
      };
    }

    if (
      Number(
        result.status
      ) === 418
    ) {
      return {
        ok: false,
        status: 418,
        message:
          'HTTP 418'
      };
    }

    if (
      Number(
        result.status
      ) < 200
      ||
      Number(
        result.status
      ) >= 300
    ) {
      return {
        ok: false,
        status:
          Number(
            result.status
          ),
        message:
          'HTTP '
          + result.status
      };
    }

    let json;

    try {
      json =
        JSON.parse(
          result.text
        );
    } catch (error) {
      return {
        ok: false,
        message:
          'JSON解析失败：'
          + error.message
      };
    }

    if (
      Number(
        json?.code
      ) !== 100000
    ) {
      return {
        ok: false,
        message:
          'API code='
          + (json?.code ?? '-')
          + ' msg='
          + (json?.msg || '-')
      };
    }

    const currentInfo =
      json?.data?.current_info
      || '';

    const experience7d =
      extractExperience7d(
        currentInfo
      );

    if (
      experience7d === null
    ) {
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
      source:
        'profile'
    };

  } finally {
    if (
      page
      &&
      !page.isClosed()
    ) {
      await page.close()
        .catch(
          () => {}
        );
    }
  }
}

async function queryJyz(
  uid
) {
  if (!USE_PROXY) {
    const serviceResult =
      await queryJyzService(
        uid
      );

    if (
      serviceResult.ok
    ) {
      return serviceResult;
    }

    if (
      !serviceResult.unavailable
    ) {
      return serviceResult;
    }
  }

  const maxAttempts =
    Math.max(
      1,
      Number(
        process.env.JYZ_BACKFILL_PROXY_RETRIES
      )
      || 5
    );

  let lastResult =
    null;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {
    try {
      const result =
        await queryJyzLocal(
          uid
        );

      lastResult =
        result;

      if (
        result.ok
      ) {
        return result;
      }

      if (
        Number(
          result.status
        ) === 418
        ||
        /HTTP 418/i.test(
          result.message
          || ''
        )
      ) {
        await rotateBackfillProxy(
          'HTTP 418',
          false
        );

        console.log(
          '[JYZ补数][重试] UID='
          + uid
          + ' | 418后换代理 | '
          + attempt
          + '/'
          + maxAttempts
        );

        continue;
      }

      if (
        isProxyConnectionError(
          result.message
          || ''
        )
      ) {
        await rotateBackfillProxy(
          result.message
          || '代理连接失败',
          true
        );

        console.log(
          '[JYZ补数][重试] UID='
          + uid
          + ' | 代理连接失败后换代理 | '
          + attempt
          + '/'
          + maxAttempts
        );

        continue;
      }

      return result;

    } catch (error) {
      const message =
        error?.message
        || String(error);

      lastResult = {
        ok: false,
        message
      };

      if (
        isProxyConnectionError(
          message
        )
      ) {
        await rotateBackfillProxy(
          message,
          true
        );

        continue;
      }

      throw error;
    }
  }

  return (
    lastResult
    || {
      ok: false,
      message:
        '代理重试次数已用完'
    }
  );
}

(async () => {
  initDatabase();

  const updateStmt =
    db.prepare(`
      UPDATE superlike_posts
      SET experience_7d = ?
      WHERE id = ?
        AND experience_7d IS NULL
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

  const promotedUids =
    new Set();

  console.log('');
  console.log(
    '=============================================='
  );
  console.log(
    '# JYZ 全库空值补数'
  );
  console.log(
    '# 筛选：全库 experience_7d IS NULL'
  );
  console.log(
    '# 顺序：post_created_at 新 → 旧，时间为空时按 id DESC 兜底'
  );
  console.log(
    '# 每轮最多：'
    + BATCH_SIZE
    + ' 条'
  );
  console.log(
    '# 每轮结束休息：'
    + Math.round(
        REST_MS / 1000
      )
    + ' 秒，然后重新查询最新数据'
  );
  console.log(
    '# 规则：经验值 > 80 -> 写入 superlike_users，并删除该UID全部 superlike_posts'
  );
  console.log(
    '# 经验值 <= 80 -> 仅更新 experience_7d'
  );
  console.log(
    '# 网络：'
    + (
      USE_PROXY
        ? '健康代理池（显式开启）'
        : '老主浏览器 profile：data/superlike-browser-profile-scan'
    )
  );
  console.log(
    '=============================================='
  );
  console.log('');

  while (true) {
    const rows =
      selectBatchStmt.all(
        BATCH_SIZE
      );

    if (
      rows.length === 0
    ) {
      console.log('');
      console.log(
        '========== JYZ补数完成 =========='
      );
      console.log(
        '全库已没有 experience_7d 为空的数据。'
      );
      console.log(
        '总处理：'
        + totalProcessed
      );
      console.log(
        '总更新：'
        + totalUpdated
      );
      console.log(
        '总失败：'
        + totalFailed
      );
      console.log(
        '经验值>80加入超LIKE：'
        + totalPromoted
      );
      console.log(
        '因经验值>80删除帖子：'
        + totalDeletedPosts
      );
      break;
    }

    round++;

    console.log('');
    console.log(
      '========== JYZ 第 '
      + round
      + ' 轮 =========='
    );
    console.log(
      '[JYZ补数] 本轮取最新空值 '
      + rows.length
      + ' 条'
    );

    let roundUpdated = 0;
    let roundFailed = 0;
    let roundPromoted = 0;
    let roundDeletedPosts = 0;

    for (
      let i = 0;
      i < rows.length;
      i++
    ) {
      const row =
        rows[i];

      const normalizedUid =
        String(
          row.uid
          || ''
        ).trim();

      if (
        normalizedUid
        &&
        promotedUids.has(
          normalizedUid
        )
      ) {
        console.log(
          '[JYZ补数][跳过] UID='
          + normalizedUid
          + ' | 本轮已因经验值>80加入超LIKE并删除全部帖子'
        );
        continue;
      }

      totalProcessed++;

      console.log(
        '[JYZ补数] '
        + (i + 1)
        + '/'
        + rows.length
        + ' | UID='
        + row.uid
        + ' | Post='
        + row.post_id
        + ' | 发帖='
        + (row.post_created_at || '-')
        + ' | first_seen_at='
        + (row.first_seen_at || '-')
      );

      const result =
        await queryJyz(
          row.uid
        );

      if (
        result.ok
        &&
        Number.isFinite(
          Number(
            result.experience7d
          )
        )
      ) {
        const experience7d =
          Number(
            result.experience7d
          );

        /*
         * 近7天经验值严格 > 80：
         * 直接视为已达到超LIKE门槛，不再保留候选帖子。
         * 先写 superlike_users，再按UID删除全部 superlike_posts。
         */
        if (
          experience7d > 80
        ) {
          const userInserted =
            saveSuperLikeUser(
              Number(
                row.monitor_id
              ),
              normalizedUid,
              null,
              experience7d
            );

          const deletedPosts =
            deletePostsByUidWithLog(
              normalizedUid,
              'EXPERIENCE_7D_GT_80'
            );

          promotedUids.add(
            normalizedUid
          );

          roundPromoted++;
          totalPromoted++;
          roundDeletedPosts +=
            deletedPosts;
          totalDeletedPosts +=
            deletedPosts;

          console.log(
            '[JYZ补数][经验值>80→超LIKE] UID='
            + normalizedUid
            + ' | jyz='
            + experience7d
            + ' | superlike_users='
            + (
              userInserted
                ? '新增'
                : '已存在/更新'
            )
            + ' | 删除帖子='
            + deletedPosts
            + ' | 来源='
            + (result.source || '-')
          );

          continue;
        }

        const changes =
          updateStmt.run(
            experience7d,
            Number(
              row.id
            )
          ).changes
          || 0;

        if (
          changes > 0
        ) {
          roundUpdated++;
          totalUpdated++;

          console.log(
            '[JYZ补数][更新] UID='
            + row.uid
            + ' | jyz='
            + experience7d
            + ' | 来源='
            + (result.source || '-')
            + ' | 本轮更新='
            + roundUpdated
            + ' | 总更新='
            + totalUpdated
          );
        } else {
          console.log(
            '[JYZ补数][跳过] UID='
            + row.uid
            + ' | 记录可能已被其他进程更新'
          );
        }
      } else {
        roundFailed++;
        totalFailed++;

        console.log(
          '[JYZ补数][失败] UID='
          + row.uid
          + ' | '
          + (result.message || 'unknown')
        );
      }

      if (
        REQUEST_DELAY_MS > 0
        &&
        i < rows.length - 1
      ) {
        await sleep(
          REQUEST_DELAY_MS
        );
      }
    }

    console.log(
      '[JYZ补数][本轮完成] 处理='
      + rows.length
      + ' | 更新='
      + roundUpdated
      + ' | >80加入超LIKE='
      + roundPromoted
      + ' | 删除帖子='
      + roundDeletedPosts
      + ' | 失败='
      + roundFailed
    );

    console.log(
      '[JYZ补数] 休息 '
      + Math.round(
          REST_MS / 1000
        )
      + ' 秒；之后重新查询全库，并再次从最新发帖开始。'
    );

    await sleep(
      REST_MS
    );
  }

  await closeLocalContext();
})()
  .catch(
    async error => {
      console.error(
        '[JYZ补数] 异常：',
        error
      );

      await closeLocalContext();

      process.exitCode = 1;
    }
  );