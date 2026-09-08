const path = require('path');
const { chromium } = require('playwright');
const {
  ProxyPool
} = require('../src/proxy-pool');
const {
  db,
  initDatabase
} = require('../src/db');

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
  || 5 * 60 * 1000;

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

function getChinaDateString(
  date = new Date()
) {
  const parts =
    new Intl.DateTimeFormat(
      'en-CA',
      {
        timeZone:
          'Asia/Shanghai',
        year:
          'numeric',
        month:
          '2-digit',
        day:
          '2-digit'
      }
    )
      .formatToParts(
        date
      );

  const map = {};

  for (
    const part
    of parts
  ) {
    if (
      part.type !==
      'literal'
    ) {
      map[part.type] =
        part.value;
    }
  }

  return (
    map.year
    + '-'
    + map.month
    + '-'
    + map.day
  );
}

function parsePostTimeMs(
  value
) {
  if (!value) {
    return null;
  }

  let date =
    new Date(
      value
    );

  if (
    Number.isNaN(
      date.getTime()
    )
    &&
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(
      String(value)
    )
  ) {
    date =
      new Date(
        String(value)
          .replace(
            ' ',
            'T'
          )
        + '+08:00'
      );
  }

  return Number.isNaN(
    date.getTime()
  )
    ? null
    : date.getTime();
}

function chinaDateFromMs(ms) {
  return getChinaDateString(
    new Date(ms)
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
  /*
   * 默认补数全部走代理。
   * 如需临时恢复旧行为，可设置 JYZ_BACKFILL_USE_PROXY=0。
   */
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

  const today =
    getChinaDateString();

  const rows =
    db.prepare(`
      SELECT
        id,
        uid,
        username,
        post_id,
        post_created_at
      FROM superlike_posts
      WHERE experience_7d IS NULL
      ORDER BY id DESC
    `)
      .all();

  const todayRows =
    rows
      .map(
        row => ({
          ...row,
          post_created_at_ms:
            parsePostTimeMs(
              row.post_created_at
            )
        })
      )
      .filter(
        row =>
          Number.isFinite(
            Number(
              row.post_created_at_ms
            )
          )
          &&
          chinaDateFromMs(
            row.post_created_at_ms
          ) === today
      )
      .sort(
        (a, b) =>
          Number(
            b.post_created_at_ms
          )
          -
          Number(
            a.post_created_at_ms
          )
      );

  console.log('');
  console.log(
    '=============================================='
  );
  console.log(
    '# JYZ 今日空值补数'
  );
  console.log(
    '# 中国日期：'
    + today
  );
  console.log(
    '# 待处理：'
    + todayRows.length
  );
  console.log(
    '# 顺序：发帖时间 新 → 旧'
  );
  console.log(
    '# 每成功更新 '
    + BATCH_SIZE
    + ' 个休息 '
    + Math.round(
        REST_MS / 60000
      )
    + ' 分钟'
  );
  console.log(
    '# 仅更新：experience_7d'
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

  const updateStmt =
    db.prepare(`
      UPDATE superlike_posts
      SET experience_7d = ?
      WHERE id = ?
        AND experience_7d IS NULL
    `);

  let processed = 0;
  let updated = 0;
  let failed = 0;

  for (
    let i = 0;
    i < todayRows.length;
    i++
  ) {
    const row =
      todayRows[i];

    processed++;

    console.log(
      '[JYZ补数] '
      + processed
      + '/'
      + todayRows.length
      + ' | UID='
      + row.uid
      + ' | Post='
      + row.post_id
      + ' | 发帖='
      + row.post_created_at
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
      const changes =
        updateStmt.run(
          Number(
            result.experience7d
          ),
          Number(
            row.id
          )
        ).changes
        || 0;

      if (
        changes > 0
      ) {
        updated++;

        console.log(
          '[JYZ补数][更新] UID='
          + row.uid
          + ' | jyz='
          + result.experience7d
          + ' | 来源='
          + (result.source || '-')
          + ' | 已更新='
          + updated
        );
      } else {
        console.log(
          '[JYZ补数][跳过] UID='
          + row.uid
          + ' | 记录可能已被其他进程更新'
        );
      }
    } else {
      failed++;

      console.log(
        '[JYZ补数][失败] UID='
        + row.uid
        + ' | '
        + (result.message || 'unknown')
      );
    }

    if (
      updated > 0
      &&
      updated % BATCH_SIZE === 0
      &&
      i < todayRows.length - 1
    ) {
      console.log('');
      console.log(
        '[JYZ补数] 已成功更新 '
        + updated
        + ' 个，休息 '
        + Math.round(
            REST_MS / 60000
          )
        + ' 分钟...'
      );
      console.log('');

      await sleep(
        REST_MS
      );
    } else if (
      REQUEST_DELAY_MS > 0
      &&
      i < todayRows.length - 1
    ) {
      await sleep(
        REQUEST_DELAY_MS
      );
    }
  }

  console.log('');
  console.log(
    '========== JYZ补数完成 =========='
  );
  console.log(
    '待处理：'
    + todayRows.length
  );
  console.log(
    '实际处理：'
    + processed
  );
  console.log(
    '成功更新：'
    + updated
  );
  console.log(
    '失败：'
    + failed
  );

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
