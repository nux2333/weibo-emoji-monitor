const {
  createBatchLogger
} = require('../src/batch-logger');

const batchLogger =
  createBatchLogger(
    'refresh-old-superlike-posts'
  );

const {
  chromium
} = require('playwright');

const {
  db,
  initDatabase,
  getSuperLikeMonitors,
  saveSuperLikeUser
} = require('../src/db');

const {
  parseTopicHomepage
} = require('../src/superlike/monitor-scanner');

const {
  checkUserSuperLikeByProfile
} = require('../src/superlike/profile');

const {
  checkSuperLikeByBrowser
} = require('../src/superlike/mode3-profile');

const {
  getPostId,
  getCommentsCount,
  getPostCreatedAt,
  parsePostCreatedAtMs
} = require('../src/superlike/post-utils');

const {
  saveTargetPost,
  deletePostsByUidWithLog
} = require('../src/superlike/post-save');

const {
  acquireScanProxyWaiting,
  SCAN_PROXY_POOL,
  isProxyConnectionError
} = require('../src/superlike/proxy');

function getArgValue(
  name,
  fallback
) {
  const prefix =
    `--${name}=`;

  const item =
    process.argv.find(
      value =>
        value.startsWith(
          prefix
        )
    );

  if (!item) {
    return fallback;
  }

  return item.slice(
    prefix.length
  );
}

const LIMIT =
  Math.max(
    1,
    Number(
      getArgValue(
        'limit',
        process.env.SUPERLIKE_OLD_REFRESH_LIMIT
        || 100
      )
    )
    || 100
  );

const PROFILE_DELAY_MS =
  Math.max(
    0,
    Number(
      getArgValue(
        'delay-ms',
        process.env.SUPERLIKE_OLD_REFRESH_DELAY_MS
        || 300
      )
    )
    || 0
  );

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

function chinaDateKey(
  ms
) {
  if (
    !Number.isFinite(
      Number(ms)
    )
  ) {
    return null;
  }

  return new Intl.DateTimeFormat(
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
  ).format(
    new Date(
      Number(ms)
    )
  );
}

/*
 * 主页第一页候选规则：
 * - 只要评论 <21
 * - 先选“最新日期”
 * - 同一天选评论数最多
 * - 同日同评论数再选发帖时间更晚
 */
function pickRefreshCandidate(
  profilePosts
) {
  if (
    !Array.isArray(
      profilePosts
    )
  ) {
    return null;
  }

  const items =
    profilePosts
      .map(
        post => {
          const comments =
            getCommentsCount(
              post
            );

          const createdAtMs =
            parsePostCreatedAtMs(
              post
            );

          return {
            post,
            comments,
            createdAtMs,
            dateKey:
              chinaDateKey(
                createdAtMs
              )
          };
        }
      )
      .filter(
        item =>
          item.comments !== null
          &&
          item.comments < 21
          &&
          Number.isFinite(
            Number(
              item.createdAtMs
            )
          )
          &&
          item.dateKey
      )
      .sort(
        (a, b) => {
          if (
            a.dateKey
            !== b.dateKey
          ) {
            return b.dateKey
              .localeCompare(
                a.dateKey
              );
          }

          if (
            a.comments
            !== b.comments
          ) {
            return b.comments
              - a.comments;
          }

          return Number(
            b.createdAtMs
          )
          - Number(
            a.createdAtMs
          );
        }
      );

  return items[0]?.post
    || null;
}

function getOldUsers(
  monitorId,
  limit
) {
  /*
   * first_seen_at 在库里是 UTC；
   * 两边都 +8h 后，以中国时间“昨天00:00”为边界比较。
   *
   * 今天已经成功检查过的 UID 不再重复。
   */
  return db.prepare(`
    SELECT
      sp.uid,
      MAX(sp.username) AS username,
      MIN(sp.first_seen_at) AS oldest_first_seen_at,
      COUNT(*) AS post_count
    FROM superlike_posts sp
    WHERE sp.monitor_id = ?
      AND sp.uid IS NOT NULL
      AND TRIM(sp.uid) <> ''
      AND datetime(
            sp.first_seen_at,
            '+8 hours'
          )
          <
          datetime(
            'now',
            '+8 hours',
            'start of day',
            '-1 day'
          )
      AND NOT EXISTS (
        SELECT 1
        FROM superlike_old_refresh_state s
        WHERE s.monitor_id = sp.monitor_id
          AND s.uid = sp.uid
          AND s.checked_date =
              date(
                'now',
                '+8 hours'
              )
      )
    GROUP BY sp.uid
    ORDER BY
      datetime(
        MIN(sp.first_seen_at)
      ) ASC,
      MIN(sp.id) ASC
    LIMIT ?
  `).all(
    Number(monitorId),
    Number(limit)
  );
}

function markChecked(
  monitorId,
  uid,
  result
) {
  db.prepare(`
    INSERT INTO superlike_old_refresh_state(
      monitor_id,
      uid,
      checked_date,
      result,
      checked_at
    )
    VALUES(
      ?,
      ?,
      date('now', '+8 hours'),
      ?,
      datetime('now', '+8 hours')
    )
    ON CONFLICT(
      monitor_id,
      uid,
      checked_date
    )
    DO UPDATE SET
      result =
        excluded.result,
      checked_at =
        excluded.checked_at
  `).run(
    Number(monitorId),
    String(uid),
    String(result || 'UNKNOWN')
  );
}

async function openBrowser() {
  const assignment =
    await acquireScanProxyWaiting();

  const proxy =
    assignment?.proxy
    || null;

  console.log(
    proxy
      ? `[OldRefresh] 使用健康代理：${assignment.masked}`
      : '[OldRefresh] 当前使用本地IP'
  );

  const browser =
    await chromium.launch({
      channel:
        'chromium',
      headless:
        true,
      ignoreHTTPSErrors:
        true,
      ...(proxy
        ? {
            proxy
          }
        : {})
    });

  const context =
    await browser.newContext({
      ignoreHTTPSErrors:
        true,
      viewport: {
        width: 1280,
        height: 900
      }
    });

  console.log(
    '[OldRefresh] 已创建与Mode3一致的Visitor Context：ignoreHTTPSErrors=true，复用游客Cookie/会话。'
  );

  return {
    browser,
    context,
    assignment
  };
}

async function runMonitor(
  monitor
) {
  const config =
    parseTopicHomepage(
      monitor.url
    );

  const users =
    getOldUsers(
      monitor.id,
      LIMIT
    );

  console.log('');
  console.log(
    '=============================================='
  );
  console.log(
    `[OldRefresh] Monitor=${monitor.name} | 本轮待检查=${users.length} | limit=${LIMIT}`
  );
  console.log(
    '[OldRefresh] 筛选条件：first_seen_at < 中国时间昨天00:00'
  );
  console.log(
    '=============================================='
  );

  if (
    users.length === 0
  ) {
    return {
      checked: 0,
      superLike: 0,
      replaced: 0,
      kept: 0,
      noCandidate: 0,
      failed: 0
    };
  }

  let state =
    await openBrowser();

  const summary = {
    checked: 0,
    superLike: 0,
    replaced: 0,
    inserted: 0,
    kept: 0,
    noCandidate: 0,
    failed: 0
  };

  try {
    for (
      let index = 0;
      index < users.length;
      index++
    ) {
      const user =
        users[index];

      const uid =
        String(
          user.uid
        );

      console.log('');
      console.log(
        `[OldRefresh ${index + 1}/${users.length}] UID=${uid} | 用户=${user.username || '-'} | first_seen_at=${user.oldest_first_seen_at || '-'} | 旧帖=${user.post_count}`
      );

      let profileResult;

      try {
        /*
         * 先完全复用 Mode3 的 profile_allbadge 游客链路：
         * - visitor.passport 初始化
         * - 同一 Visitor Context 复用游客 Cookie
         * - ignoreHTTPSErrors=true
         *
         * allbadge 只负责确认当前是否已经是超LIKE。
         */
        const allbadgeResult =
          await checkSuperLikeByBrowser(
            state.context,
            config,
            uid,
            null,
            'OldRefresh'
          );

        if (
          !allbadgeResult?.ok
        ) {
          profileResult = {
            ok: false,
            hasSuperLike:
              null,
            status:
              allbadgeResult?.status
              ?? null,
            message:
              allbadgeResult?.message
              || 'profile_allbadge失败'
          };

        } else if (
          allbadgeResult.hasSuperLike
        ) {
          profileResult = {
            ok: true,
            hasSuperLike:
              true,
            profilePosts:
              []
          };

        } else {
          /*
           * allbadge 已确认“未超LIKE”后，再用同一个 Visitor Context
           * 打开 profile_inpage，只为取得主页第一页帖子。
           */
          profileResult =
            await checkUserSuperLikeByProfile(
              state.context,
              config,
              uid,
              state.context
            );
        }

      } catch (error) {
        if (
          state.assignment?.raw
          &&
          isProxyConnectionError(
            error
          )
        ) {
          console.log(
            `[OldRefresh][代理失败] UID=${uid} | ${error.message} | 淘汰当前代理并换代理`
          );

          try {
            SCAN_PROXY_POOL.remove(
              state.assignment.raw
            );
          } catch {
            // ignore
          }

          try {
            await state.context.close();
          } catch {
            // ignore
          }

          try {
            await state.browser.close();
          } catch {
            // ignore
          }

          state =
            await openBrowser();

          index--;
          continue;
        }

        throw error;
      }

      if (
        !profileResult?.ok
      ) {
        const failureText =
          String(
            profileResult?.message
            || profileResult?.error
            || ''
          );

        /*
         * Profile helper 很多网络错误会包装成 ok=false 返回，
         * 不一定 throw。这里再次识别代理/网络类错误：
         * 命中后淘汰当前代理、重建浏览器，并重试当前 UID。
         */
        if (
          state.assignment?.raw
          &&
          (
            isProxyConnectionError(
              new Error(
                failureText
              )
            )
            ||
            /ERR_CERT_AUTHORITY_INVALID/i.test(
              failureText
            )
            ||
            /ERR_SOCKS_CONNECTION_FAILED/i.test(
              failureText
            )
            ||
            /ERR_EMPTY_RESPONSE/i.test(
              failureText
            )
            ||
            /ERR_HTTP_RESPONSE_CODE_FAILURE/i.test(
              failureText
            )
            ||
            /Failed to fetch/i.test(
              failureText
            )
            ||
            /timed?\s*out/i.test(
              failureText
            )
          )
        ) {
          console.log(
            `[OldRefresh][代理失败] UID=${uid} | ${failureText || '-'} | 淘汰当前代理并换代理后重试当前UID`
          );

          try {
            SCAN_PROXY_POOL.remove(
              state.assignment.raw
            );
          } catch {
            // ignore
          }

          try {
            await state.context.close();
          } catch {
            // ignore
          }

          try {
            await state.browser.close();
          } catch {
            // ignore
          }

          state =
            await openBrowser();

          index--;
          continue;
        }

        /*
         * 每天整批跑完模式下，最终仍失败的 UID 今天先记为 PROFILE_FAILED，
         * 避免下一批立刻再次取到同一个 UID 造成死循环。
         * 明天 checked_date 改变后会自动重新进入待检查范围。
         */
        markChecked(
          monitor.id,
          uid,
          'PROFILE_FAILED'
        );

        summary.failed++;

        console.log(
          `[OldRefresh][Profile失败] UID=${uid} | ${failureText || '-'} | 今天标记PROFILE_FAILED，明天自动重试`
        );

        if (
          PROFILE_DELAY_MS > 0
        ) {
          await sleep(
            PROFILE_DELAY_MS
          );
        }

        continue;
      }

      summary.checked++;

      if (
        profileResult.hasSuperLike
      ) {
        saveSuperLikeUser(
          monitor.id,
          uid
        );

        const deleted =
          deletePostsByUidWithLog(
            uid,
            'SUPERLIKE_OLD_REFRESH'
          );

        markChecked(
          monitor.id,
          uid,
          'SUPERLIKE'
        );

        summary.superLike++;

        console.log(
          `[OldRefresh][已超LIKE] UID=${uid} | 删除旧候选=${deleted}`
        );

        if (
          PROFILE_DELAY_MS > 0
        ) {
          await sleep(
            PROFILE_DELAY_MS
          );
        }

        continue;
      }

      const targetPost =
        pickRefreshCandidate(
          profileResult.profilePosts
        );

      if (!targetPost) {
        markChecked(
          monitor.id,
          uid,
          'NO_CANDIDATE'
        );

        summary.noCandidate++;

        console.log(
          `[OldRefresh][无新候选] UID=${uid} | 主页第一页没有评论<21的帖子 | 保留旧记录`
        );

        if (
          PROFILE_DELAY_MS > 0
        ) {
          await sleep(
            PROFILE_DELAY_MS
          );
        }

        continue;
      }

      const targetPostId =
        getPostId(
          targetPost
        );

      const saved =
        saveTargetPost(
          monitor.id,
          targetPost,
          'NO_SUPERLIKE'
        );

      markChecked(
        monitor.id,
        uid,
        saved.status
      );

      if (
        saved.status ===
        'replaced'
      ) {
        summary.replaced++;

        console.log(
          `[OldRefresh][换新帖] UID=${uid} | Post=${targetPostId} | 评论=${getCommentsCount(targetPost)} | 时间=${getPostCreatedAt(targetPost) || '-'} | first_seen_at已重新生成`
        );

      } else if (
        saved.status ===
        'inserted'
      ) {
        summary.inserted++;

        console.log(
          `[OldRefresh][新入库] UID=${uid} | Post=${targetPostId} | 评论=${getCommentsCount(targetPost)} | 时间=${getPostCreatedAt(targetPost) || '-'}`
        );

      } else {
        summary.kept++;

        console.log(
          `[OldRefresh][保留旧帖] UID=${uid} | Profile候选Post=${targetPostId} | saveStatus=${saved.status}`
        );
      }

      if (
        PROFILE_DELAY_MS > 0
      ) {
        await sleep(
          PROFILE_DELAY_MS
        );
      }
    }

  } finally {
    try {
      await state.context.close();
    } catch {
      // ignore
    }

    try {
      await state.browser.close();
    } catch {
      // ignore
    }
  }

  return summary;
}

async function initDatabaseWithRetry() {
  const maxAttempts =
    12;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {
    try {
      initDatabase();
      return;

    } catch (error) {
      const locked =
        error?.errcode === 5
        ||
        error?.code === 'SQLITE_BUSY'
        ||
        error?.code === 'ERR_SQLITE_ERROR'
        &&
        /database is locked/i.test(
          String(
            error?.message
            || ''
          )
        );

      if (
        !locked
        ||
        attempt >= maxAttempts
      ) {
        throw error;
      }

      const waitMs =
        5000;

      console.log(
        `[OldRefresh][DB锁等待] initDatabase 被其他进程占用 | 第${attempt}/${maxAttempts}次 | ${waitMs / 1000}秒后重试`
      );

      await sleep(
        waitMs
      );
    }
  }
}


async function main() {
  await initDatabaseWithRetry();

  const monitors =
    getSuperLikeMonitors();

  console.log('');
  console.log(
    '################################################'
  );
  console.log(
    '# Old SuperLike Candidate Refresh'
  );
  console.log(
    `# 每批最多 ${LIMIT} UID；自动连续处理直到今天的老UID全部跑完`
  );
  console.log(
    '# 老数据边界：first_seen_at < 中国时间昨天00:00'
  );
  console.log(
    '# 主页：只看第一页'
  );
  console.log(
    '# 候选：评论<21；最新日期优先，同日评论最多优先'
  );
  console.log(
    '# 换帖：沿用 DELETE + INSERT，因此 first_seen_at 重置为今天'
  );
  console.log(
    '################################################'
  );

  const total = {
    checked: 0,
    superLike: 0,
    replaced: 0,
    inserted: 0,
    kept: 0,
    noCandidate: 0,
    failed: 0
  };

  for (
    const monitor
    of monitors
  ) {
    let batchNo =
      0;

    while (true) {
      const pending =
        getOldUsers(
          monitor.id,
          LIMIT
        );

      if (
        pending.length === 0
      ) {
        console.log('');
        console.log(
          `[OldRefresh] Monitor=${monitor.name} | 今日老UID已全部处理完 | 批次数=${batchNo}`
        );
        break;
      }

      batchNo++;

      console.log('');
      console.log(
        `[OldRefresh] Monitor=${monitor.name} | 开始第${batchNo}批 | 待处理=${pending.length} | 每批上限=${LIMIT}`
      );

      const result =
        await runMonitor(
          monitor
        );

      for (
        const key
        of Object.keys(
          total
        )
      ) {
        total[key] +=
          Number(
            result[key]
            || 0
          );
      }

      /*
       * 每批之间稍停一下，让 Scanner / JYZ 等其他写库进程有机会抢到锁。
       */
      await sleep(
        1000
      );
    }
  }

  console.log('');
  console.log(
    '================ OldRefresh 结果 ================'
  );
  console.log(
    `成功检查：${total.checked}`
  );
  console.log(
    `已超LIKE删除：${total.superLike}`
  );
  console.log(
    `换成新帖：${total.replaced}`
  );
  console.log(
    `新入库：${total.inserted}`
  );
  console.log(
    `保留旧帖：${total.kept}`
  );
  console.log(
    `主页无候选：${total.noCandidate}`
  );
  console.log(
    `Profile失败：${total.failed}`
  );
  console.log(
    '==================================================='
  );
}

main()
  .catch(
    error => {
      console.error(
        '[OldRefresh] 致命错误：',
        error
      );

      process.exitCode = 1;
    }
  )
  .finally(
    async () => {
      try {
        await batchLogger.close();
      } catch {
        // ignore
      }
    }
  );
