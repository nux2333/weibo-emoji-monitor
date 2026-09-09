const {
  createBatchLogger
} = require('./batch-logger');

let batchLogger = null;

if (require.main === module) {
  const workerLabel =
    String(
      process.env.SUPERLIKE_SCAN_WORKER_LABEL
      || process.env.SUPERLIKE_SCAN_WORKER_SOURCE
      || process.env.SUPERLIKE_SCAN_WORKER_MODE
      || 'legacy'
    )
      .replace(
        /[^a-zA-Z0-9_-]/g,
        '_'
      );

  batchLogger =
    createBatchLogger(
      `scan-superlike-${workerLabel}`
    );
}

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
  getPostId,
  getUid,
  getUsername,
  getPostText,
  getPostLink,
  getCommentsCount,
  getPostCreatedAt,
  parsePostCreatedAtMs,
  getNewestPostInfo,
  shouldStopAtCheckpoint,
  hasSuperLike,
  extractIcons,
  findPosts
} = require('./superlike/post-utils');
const {
  SCAN_PROXY_POOL,
  acquireScanProxyWaiting,
  Weibo418Error,
  isWeibo418Error,
  isProxyConnectionError,
  assertPageNot418
} = require('./superlike/proxy');
const {
  parseChaohuaRequestUrl,
  waitForChaohuaResponse,
  clickPrimaryLatest,
  extractLatestPostFlowId,
  extractNextPageParams,
  extractTagNextPageParams,
  buildTagSectionUrl,
  buildChaohuaUrl,
  fetchJsonInPageWithRetry,
  fetchChaohuaInPage,
  clickLatestPostTab,
  triggerNextPage
} = require('./superlike/chaohua-api');
const {
  buildProfileInPageApiUrl,
  profileHasSuperLike,
  checkUserSuperLikeByProfile,
  getProfilePosts,
  pickProfileReplacementPost
} = require('./superlike/profile');
const {
  initSuperLikeTable,
  deletePostsByUidWithLog,
  postIdExists
} = require('./superlike/post-save');
const { processPagePosts } = require('./superlike/page-processor');
const {
  initDatabase,
  getSuperLikeMonitors,
  superLikePostIdExists,
  getExistingSuperLikeUids,
  isSuperLikeUser,
  getRecentSuperLikeProfileStatus,
  markSuperLikeProfileChecked,
  saveSuperLikeUser,
  saveSuperLikeTargetPost,
  deletePostsByUidSet,
  markDailyExcludedUser,
  isDailyExcludedUser,
  cleanupSuperLikePostsByUsersTable,
  getScanCheckpoint,
  saveScanCheckpoint,
  getScanResume,
  saveScanResume,
  clearScanResume,
  getScanSourceCheckpoint,
  saveScanSourceCheckpoint,
  getScanSourceResume,
  saveScanSourceResume,
  clearScanSourceResume,
  addSuperLikePoolExitCount
} = require('./db');

/**
 * ============================================================
 * SuperLike Batch - 从 _feed Response 解析“最新发帖”版
 *
 * 流程：
 * 1. 打开真实超话首页
 * 2. 点击一级“最新”
 * 3. 捕获 _-_feed 第一页真实 Response
 * 4. 从 Response:
 *      items
 *        -> page_feed_child_tab
 *        -> filter_group
 *        -> name = 最新发帖
 *        -> containerid = ..._-_sort_time
 * 5. 在当前页面上下文中请求 sort_time 第一页
 * 6. 从 sort_time Response 的 moreInfo.params 读取下一页，并直接 AJAX 请求：
 *      page
 *      since_id
 *      max_id
 * 7. Fresh 从第一页开始追到上一轮 checkpoint；最多100页兜底
 * 8. Fresh按“最新发帖10页 + 三个专区各10页”分批即时处理，Profile默认2并发
 * 9. 历史 Resume 不阻塞 fresh；单轮历史预算默认5分钟
 * 10. UID不在 superlike_users + feed/Profile无chao_like + 评论<21 才入库
 * 11. 白天按10分钟、晚高峰按3分钟的“启动间隔”循环；上一轮未结束时不重叠
 * ============================================================
 */

const DAY_SCAN_INTERVAL_MS =
  Number(process.env.SUPERLIKE_DAY_SCAN_INTERVAL_MS)
  || 10 * 60 * 1000;

const NIGHT_SCAN_INTERVAL_MS =
  Number(process.env.SUPERLIKE_NIGHT_SCAN_INTERVAL_MS)
  || 3 * 60 * 1000;

const RATE_LIMIT_BACKOFF_1_MS =
  Number(process.env.SUPERLIKE_418_BACKOFF_1_MS)
  || 30 * 60 * 1000;

const RATE_LIMIT_BACKOFF_2_MS =
  Number(process.env.SUPERLIKE_418_BACKOFF_2_MS)
  || 60 * 60 * 1000;

let consecutive418 = 0;
let running = false;

/*
 * Worker 模式：
 * - 默认 legacy：保持单进程旧行为，便于回滚。
 * - fresh：由 SUPERLIKE_SCAN_WORKER_SOURCE 指定唯一 Fresh 来源。
 * - history：只补 Resume，不参与 Fresh。
 */
const {
  scanOneSuperLikeMonitor,
  parseTopicHomepage,
  SCAN_PROFILE_CACHE_MINUTES
} = require('./superlike/monitor-scanner');

/* ============================================================
 * One round
 * ============================================================ */

async function scanSuperLikePosts() {
  if (running) {
    console.log(
      '[SuperLike] 上一轮尚未结束，本轮跳过。'
    );

    return;
  }


  running = true;


  try {
    initDatabase();


    const deleteUidSet =
      new Set();

    const monitors =
      getSuperLikeMonitors();


    if (
      monitors.length === 0
    ) {
      console.log('');
      console.log(
        '[SuperLike] 没有启用的 SuperLike Monitor。'
      );

      console.log(
        "需要 monitor_type='superlike' AND enabled=1"
      );

      return;
    }


    console.log(
      `[SuperLike] 本轮 ${monitors.length} 个 Monitor`
    );


    for (
      const monitor
      of monitors
    ) {
      try {
        await scanOneSuperLikeMonitor(
          monitor,
          deleteUidSet,
          false
        );

      } catch (error) {
        if (isWeibo418Error(error)) {
          throw error;
        }

        console.error(
          `[SuperLike] ${monitor.name} 扫描失败：`,
          error
        );
      }
    }


    console.log(
      `[SuperLike][轮询末尾清理] 本轮新确认 SuperLike UID=${deleteUidSet.size}；开始按 superlike_users 全表清理 superlike_posts...`
    );

    const deletedRows =
      cleanupSuperLikePostsByUsersTable();

    console.log(
      `[SuperLike][轮询末尾清理完成] 删除 superlike_posts 记录=${deletedRows}`
    );

  } finally {
    running = false;
  }
}


/* ============================================================
 * Batch
 * ============================================================ */

async function runSuperLikeRoundSafely(label = '本轮') {
  try {
    await scanSuperLikePosts();

    consecutive418 = 0;

    return {
      ok: true,
      rateLimited: false
    };

  } catch (error) {
    if (isWeibo418Error(error)) {
      /*
       * 使用代理池时：
       * 418只处罚当前代理，不处罚整个找贴脚本。
       * 下一轮按正常20/5分钟周期执行，并自动取下一个可用代理。
       */
      if (error.proxyPoolHandled) {
        consecutive418 = 0;

        console.error(
          `[SuperLike] ${label}命中 HTTP 418；当前代理已冷却。找贴脚本不做全局退避，下一轮按正常周期换下一个代理。`
        );

        return {
          ok: false,
          rateLimited: false,
          proxyRateLimited: true
        };
      }

      /*
       * 没有代理池/本地IP触发418时，仍保留原来的全局30/60分钟退避。
       */
      consecutive418++;

      console.error(
        `[SuperLike] ${label}命中微博 HTTP 418，本轮立即停止。连续418=${consecutive418}`
      );

      return {
        ok: false,
        rateLimited: true
      };
    }

    console.error(
      `[SuperLike] ${label}扫描失败，但 Batch 不会中断：`,
      error
    );

    return {
      ok: false,
      rateLimited: false
    };
  }
}


function getChinaHour() {
  const hourText =
    new Intl.DateTimeFormat(
      'en-US',
      {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        hour12: false
      }
    ).format(
      new Date()
    );

  return Number(hourText);
}


function getNormalScanIntervalMs() {
  const hour =
    getChinaHour();

  return hour >= 19
    ? NIGHT_SCAN_INTERVAL_MS
    : DAY_SCAN_INTERVAL_MS;
}


function getNextDelayMs(result) {
  if (!result?.rateLimited) {
    return getNormalScanIntervalMs();
  }

  return consecutive418 <= 1
    ? RATE_LIMIT_BACKOFF_1_MS
    : RATE_LIMIT_BACKOFF_2_MS;
}


async function startSuperLikeBatch() {
  try {
    initDatabase();
  } catch (error) {
    console.error(
      '[SuperLike] DB初始化失败，但 Batch 继续运行，下一轮会再次尝试：',
      error
    );
  }


  console.log('');
  console.log(
    '################################################'
  );

  console.log(
    '# SuperLike Batch'
  );

  console.log(
    `# 00:00-18:59：每 ${DAY_SCAN_INTERVAL_MS / 60000} 分钟`
  );

  console.log(
    `# 19:00-23:59：每 ${NIGHT_SCAN_INTERVAL_MS / 60000} 分钟`
  );

  console.log(
    `# HTTP 418退避：第一次 ${RATE_LIMIT_BACKOFF_1_MS / 60000} 分钟，连续418 ${RATE_LIMIT_BACKOFF_2_MS / 60000} 分钟`
  );

  console.log(
    '# 一级最新 -> 捕获 _feed -> 解析最新发帖 containerid'
  );

  console.log(
    '# sort_time 分页使用 Response.moreInfo.params'
  );

  console.log(
    '# 扫描页数：中国时间白天最多100页；晚高峰最多30页'
  );

  console.log(
    '# 命中上一轮 checkpoint（最新时间 + post_id）时结束'
  );

  console.log(
    '# 每个 monitor + UID 只保留一条最新帖子'
  );

  console.log(
    '# 评论<21 + feed无chao_like + UID不在superlike_users -> Profile二次校验后决定是否入库'
  );

  console.log(
    `# Scan Profile非SuperLike缓存：${SCAN_PROFILE_CACHE_MINUTES}分钟；同一轮同UID只请求一次`
  );

  console.log(
    '# Ctrl+C 停止'
  );

  console.log(
    '################################################'
  );


  const scheduleNext = async (label) => {
    /*
     * 正常轮询按“本轮启动时间”计算下一次启动时间：
     *
     * 例如白天10分钟：
     * 12:00启动 -> 12:07结束 -> 12:10再启动。
     *
     * 如果本轮运行超过间隔，则不并发启动第二轮，
     * 当前轮结束后立即开始下一轮。
     *
     * 全局418退避仍保持原语义：
     * 从本轮结束后完整等待30/60分钟。
     */
    const roundStartedAt =
      Date.now();

    const result =
      await runSuperLikeRoundSafely(label);

    let delayMs;

    if (result?.rateLimited) {
      delayMs =
        getNextDelayMs(result);
    } else {
      const intervalMs =
        getNormalScanIntervalMs();

      const nextStartAt =
        roundStartedAt
        + intervalMs;

      delayMs =
        Math.max(
          0,
          nextStartAt - Date.now()
        );
    }

    if (delayMs <= 0) {
      console.log(
        '[SuperLike] 本轮耗时已达到/超过轮询间隔；不重叠启动，当前轮结束后立即开始下一轮。'
      );
    } else {
      console.log(
        `[SuperLike] 下一轮将在约 ${Math.ceil(delayMs / 1000)} 秒后开始。`
      );
    }

    setTimeout(
      () => {
        console.log('');
        console.log(
          '[SuperLike] 到达下一轮时间，重新开始。'
        );

        void scheduleNext('定时');
      },
      delayMs
    );
  };


  await scheduleNext('首次');
}


process.on(
  'SIGINT',
  () => {
    console.log('');
    console.log(
      '[SuperLike] Batch停止。'
    );

    process.exit(0);
  }
);


module.exports = {
  initSuperLikeTable,
  getSuperLikeMonitors,
  scanSuperLikePosts,
  runSuperLikeRoundSafely,
  isWeibo418Error,
  assertPageNot418,
  scanOneSuperLikeMonitor,
  startSuperLikeBatch,
  hasSuperLike,
  extractIcons,
  findPosts,
  getPostId,
  getUid,
  getUsername,
  getPostText,
  getPostLink,
  getCommentsCount,
  postIdExists,
  getExistingSuperLikeUids,
  deleteSuperLikeUsersByUid: deletePostsByUidSet,
  parseTopicHomepage,
  parseChaohuaRequestUrl,
  clickPrimaryLatest,
  extractLatestPostFlowId,
  extractNextPageParams,
  buildChaohuaUrl,
  fetchChaohuaInPage,
  clickLatestPostTab,
  triggerNextPage,
  buildProfileInPageApiUrl,
  profileHasSuperLike,
  checkUserSuperLikeByProfile,
  getProfilePosts,
  pickProfileReplacementPost,
  getPostCreatedAt,
  parsePostCreatedAtMs
};


if (
  require.main === module
) {
  startSuperLikeBatch()
    .catch(
      error => {
        /*
         * 最外层也不主动退出进程。
         * 正常扫描异常已经由 runSuperLikeRoundSafely() 吸收。
         */
        console.error(
          '[SuperLike] Batch主程序异常，但不主动退出：',
          error
        );
      }
    );
}