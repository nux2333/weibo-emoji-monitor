const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT =
  path.join(
    __dirname,
    '..',
    '..'
  );

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
} = require('./post-utils');

const {
  SCAN_PROXY_POOL,
  acquireScanProxyWaiting,
  Weibo418Error,
  isWeibo418Error,
  isProxyConnectionError,
  assertPageNot418
} = require('./proxy');

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
} = require('./chaohua-api');

const {
  buildProfileInPageApiUrl,
  profileHasSuperLike,
  checkUserSuperLikeByProfile,
  getProfilePosts,
  pickProfileReplacementPost
} = require('./profile');

const {
  initSuperLikeTable,
  deletePostsByUidWithLog,
  postIdExists
} = require('./post-save');

const { processPagePosts } = require('./page-processor');

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
} = require('../db');

const SCAN_WORKER_MODE =
  String(
    process.env.SUPERLIKE_SCAN_WORKER_MODE
    || 'legacy'
  ).trim().toLowerCase();

const SCAN_WORKER_SOURCE =
  String(
    process.env.SUPERLIKE_SCAN_WORKER_SOURCE
    || ''
  ).trim();

const SCAN_FORCE_LOCAL =
  String(
    process.env.SUPERLIKE_SCAN_FORCE_LOCAL
    || ''
  ).trim() === '1';

const WEIBO_LOGIN_STATE_FILE =
  process.env.WEIBO_LOGIN_STATE_FILE
    ? path.resolve(
        process.env.WEIBO_LOGIN_STATE_FILE
      )
    : path.join(
        ROOT,
        'data',
        'weibo-login-state.json'
      );

/*
 * 单轮扫描页数：
 * - 白天（中国时间 00:00-18:59）：100页
 * - 晚高峰（中国时间 19:00-23:59）：30页
 * SUPERLIKE_MAX_PAGES 仍可显式覆盖。
 */
function getScanMaxPages() {
  const configured =
    Number(
      process.env.SUPERLIKE_MAX_PAGES
    );

  if (
    Number.isFinite(configured)
    &&
    configured > 0
  ) {
    return configured;
  }

  const chinaHour =
    Number(
      new Intl.DateTimeFormat(
        'en-US',
        {
          timeZone:
            'Asia/Shanghai',
          hour:
            '2-digit',
          hour12:
            false
        }
      ).format(
        new Date()
      )
    );

  return chinaHour >= 19
    ? 30
    : 100;
}

/*
 * 最新评论 _feed 不再作为帖子扫描数据源。
 * 下面的页数配置暂时保留，便于兼容旧代码；不会主动启动最新评论采集。
 */
const LATEST_COMMENTS_PAGES =
  Number(
    process.env.SUPERLIKE_LATEST_COMMENTS_PAGES
  )
  || 20;

/*
 * 额外分区：这些帖子不会稳定出现在“最新发帖”总流中，
 * 因此作为独立 source 并发采集。
 */
const TAG_SECTION_PAGES =
  Number(
    process.env.SUPERLIKE_TAG_SECTION_PAGES
  )
  || 30;

const TAG_SECTION_CONCURRENCY =
  Math.max(
    1,
    Number(
      process.env.SUPERLIKE_TAG_SECTION_CONCURRENCY
    )
    || 2
  );

const ALL_TAG_SECTION_SOURCES = [
  {
    key: 'section-superlike',
    name: '超like',
    flowId:
      '100808f1d33f71dff693a2708cb3e8ef584a44__5183718645432593_-_tag_status_sort'
  },
  {
    key: 'section-yishanshui',
    name: '一善水区',
    flowId:
      '100808f1d33f71dff693a2708cb3e8ef584a44__10010001_-_tag_status_sort'
  },
  {
    key: 'section-qa',
    name: '答疑专区',
    flowId:
      '100808f1d33f71dff693a2708cb3e8ef584a44__5186483501006975_-_tag_status_sort'
  }
];

const TAG_SECTION_SOURCES =
  SCAN_WORKER_MODE === 'history'
    ? ALL_TAG_SECTION_SOURCES
    : SCAN_WORKER_MODE === 'fresh'
      ? ALL_TAG_SECTION_SOURCES.filter(
          source =>
            source.key ===
            SCAN_WORKER_SOURCE
        )
      : ALL_TAG_SECTION_SOURCES;

/*
 * 白天：先抓最新10页，再补历史 Resume。
 * 晚高峰（中国时间19:00-23:59）：只抓最新30页，暂停历史 Resume。
 */
const DAY_FRESH_FIRST_PAGES =
  Number(
    process.env.SUPERLIKE_DAY_FRESH_FIRST_PAGES
    || process.env.SUPERLIKE_FRESH_FIRST_PAGES
  )
  || 10;

const NIGHT_FRESH_FIRST_PAGES =
  Number(
    process.env.SUPERLIKE_NIGHT_FRESH_FIRST_PAGES
  )
  || 30;

/*
 * 历史 Resume 每轮最多补 5 分钟。
 * 到时保存下一页断点并结束当前轮，让下一轮重新先抓最新数据。
 */
const RESUME_TIME_BUDGET_MS =
  Number(
    process.env.SUPERLIKE_RESUME_TIME_BUDGET_MS
  )
  || 5 * 60 * 1000;

/*
 * History 只保留最近 N 小时的数据。
 * 默认 48 小时，可用 SUPERLIKE_HISTORY_MAX_AGE_HOURS 覆盖。
 * 为防 sort_time 偶发乱序，连续若干个完整旧页后才真正结束并清除 Resume。
 */
const HISTORY_MAX_AGE_HOURS =
  Math.max(
    1,
    Number(
      process.env.SUPERLIKE_HISTORY_MAX_AGE_HOURS
    )
    || 48
  );

const HISTORY_OLD_PAGE_THRESHOLD =
  Math.max(
    1,
    Number(
      process.env.SUPERLIKE_HISTORY_OLD_PAGE_THRESHOLD
    )
    || 4
  );

const SCAN_PROFILE_CONCURRENCY =
  Math.max(
    1,
    Number(
      process.env.SUPERLIKE_PROFILE_CONCURRENCY
    )
    || 2
  );

const EXISTING_STOP_THRESHOLD =
  Number(process.env.SUPERLIKE_EXISTING_STOP_THRESHOLD)
  || 10;

const INITIAL_WAIT_MS =
  Number(process.env.SUPERLIKE_INITIAL_WAIT_MS)
  || 3000;

const FEED_WAIT_MS =
  Number(process.env.SUPERLIKE_FEED_WAIT_MS)
  || 10000;

const PAGE_DELAY_MS =
  Number(process.env.SUPERLIKE_PAGE_DELAY_MS)
  || 1000;

const SCAN_PROFILE_CACHE_MINUTES =
  Number(
    process.env.SUPERLIKE_SCAN_PROFILE_CACHE_MINUTES
  )
  || 15;

let running = false;

function isChaohuaBusy303403(result) {
  if (!result) {
    return false;
  }

  if (
    Number(
      result.httpStatus
    ) !== 403
  ) {
    return false;
  }

  const text =
    String(
      result.text
      || result.error
      || ''
    );

  if (
    /"code"\s*:\s*303403/.test(
      text
    )
    ||
    /系统繁忙/.test(
      text
    )
  ) {
    return true;
  }

  try {
    return (
      Number(
        result.json?.code
      ) === 303403
    );
  } catch {
    return false;
  }
}


function logTagSectionDiagnostic(
  source,
  result,
  proxyAssignment,
  stage
) {
  const body =
    String(
      result?.text
      || result?.error
      || (
        result?.json
          ? JSON.stringify(
              result.json
            )
          : ''
      )
      || '-'
    )
      .replace(
        /\s+/g,
        ' '
      )
      .slice(
        0,
        300
      );

  console.log(
    [
      '[SuperLike][分区诊断]',
      `分区=${source?.name || '-'}`,
      `阶段=${stage || '-'}`,
      `flowId=${source?.flowId || '-'}`,
      `代理=${proxyAssignment?.masked || 'LOCAL'}`,
      `HTTP=${result?.httpStatus ?? '-'}`,
      `Body=${body}`
    ].join(
      ' | '
    )
  );
}


function getHistoryPageAgeState(
  posts,
  cutoffMs
) {
  if (
    !Array.isArray(posts)
    ||
    posts.length === 0
  ) {
    return {
      fullyOlder: true,
      comparablePosts: 0
    };
  }

  let comparablePosts = 0;
  let fullyOlder = true;

  for (const post of posts) {
    const postId =
      getPostId(post);

    if (!postId) {
      continue;
    }

    const createdAtMs =
      parsePostCreatedAtMs(post);

    if (
      !Number.isFinite(
        Number(createdAtMs)
      )
    ) {
      fullyOlder = false;
      break;
    }

    comparablePosts++;

    if (
      Number(createdAtMs)
      >= cutoffMs
    ) {
      fullyOlder = false;
      break;
    }
  }

  return {
    fullyOlder:
      comparablePosts > 0
        ? fullyOlder
        : true,
    comparablePosts
  };
}


/* ============================================================
 * Scan Response JSON
 * ============================================================ */

let scanResponseSequence = 0;

function getChinaDateParts(date = new Date()) {
  const parts =
    new Intl.DateTimeFormat(
      'en-CA',
      {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }
    ).formatToParts(date);

  const map = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }

  return {
    dateDir: `${map.year}-${map.month}-${map.day}`,
    stamp: `${map.year}${map.month}${map.day}-${map.hour}${map.minute}${map.second}`
  };
}

async function saveScanResponseJson(
  json,
  source = 'latest-posts'
) {
  try {
    const now = new Date();
    const { dateDir, stamp } =
      getChinaDateParts(now);

    const dir =
      path.join(
        ROOT,
        'logs',
        'scan-responses',
        dateDir,
        String(source || 'unknown')
          .replace(/[^a-zA-Z0-9_-]/g, '_')
      );

    await fs.promises.mkdir(
      dir,
      { recursive: true }
    );

    scanResponseSequence++;

    const fileName =
      `Response-${stamp}-${String(scanResponseSequence).padStart(3, '0')}.json`;

    const filePath =
      path.join(
        dir,
        fileName
      );

    await fs.promises.writeFile(
      filePath,
      JSON.stringify(json, null, 2),
      'utf8'
    );

    console.log(
      `[SuperLike][Response保存] ${path.relative(process.cwd(), filePath)}`
    );

    return filePath;

  } catch (error) {
    console.warn(
      `[SuperLike][Response保存失败] ${error?.message || error}`
    );

    return null;
  }
}


/* ============================================================
 * DB
 * ============================================================ */

// 保留 scanner 内原函数名，实际数据库查询统一交给 db.js。
/* ============================================================
 * Monitor URL
 * ============================================================ */

function parseTopicHomepage(topicUrl) {
  const url =
    new URL(
      String(topicUrl || '').trim()
    );

  const match =
    url.pathname.match(
      /^\/p\/(100808[a-zA-Z0-9]+)\/?$/
    );

  if (!match) {
    throw new Error(
      `SuperLike monitor.url 必须是超话首页：https://weibo.com/p/100808xxxx。当前=${topicUrl}`
    );
  }

  const containerId =
    match[1];

  const topicHash =
    containerId.replace(
      /^100808/,
      ''
    );

  return {
    homepage:
      `https://weibo.com/p/${containerId}`,

    hotFlowId:
      containerId,

    feedFlowId:
      `${containerId}_-_feed`,

    topicHash,

    profileContainerId:
      `231140${topicHash}_-_profile_inpage`,

    chaoLikeListContainerId:
      `231140${topicHash}_-_chaolikenew`
  };
}


/* ============================================================
 * Post helpers
 * ============================================================ */

/* ============================================================
 * Find Posts
 * ============================================================ */

/* ============================================================
 * SuperLike / icons
 * ============================================================ */

/* ============================================================
 * Save
 * ============================================================ */

/* ============================================================
 * AJAX helpers
 * ============================================================ */

/**
 * ============================================================
 * 捕获指定 flowId 的下一条 Response
 * ============================================================
 */

/**
 * ============================================================
 * 点击一级“最新”
 * ============================================================
 */
/**
 * ============================================================
 * 从 _feed Response 找“最新发帖” containerid
 * ============================================================
 */

/**
 * ============================================================
 * 从 Response 直接拿下一页参数
 *
 * 你给的 _feed Response 已确认：
 *
 * moreInfo: {
 *   pagingType: "cursor",
 *   params: {
 *     page: 2,
 *     since_id: "{\"max_id\":...}",
 *     max_id: 0
 *   }
 * }
 *
 * sort_time 也优先按同结构读取。
 * ============================================================
 */

/*
 * tag_status_sort 分区分页和 sort_time 略有不同：
 * 第二页真实请求可能没有 page=2，而只靠 since_id/max_id。
 * 所以这里不要求 params.page >= 2。
 */
/**
 * ============================================================
 * 页面内 AJAX
 *
 * 这次是在：
 *
 * 首页打开成功
 * -> 一级最新点击成功
 * -> _feed 请求 200 成功
 *
 * 之后才请求 sort_time。
 *
 * 比之前一进入页面就裸 fetch 多了一层真实前端状态。
 * ============================================================
 */

/**
 * ============================================================
 * 等待并点击二级“最新发帖”
 * ============================================================
 */
/**
 * ============================================================
 * 滚动页面，让微博前端自己触发下一页 AJAX
 * ============================================================
 */
/**
 * ============================================================
 * 构造用户在当前超话的 profile_inpage API URL
 *
 * 页面形式：
 * https://m.weibo.cn/p/index?containerid=231140{hash}_-_profile_inpage
 *
 * 实际 JSON API：
 * https://m.weibo.cn/api/container/getIndex?... 
 *
 * extparam 的目标值是：
 * target_uid#123456
 *
 * 在这个接口里需要嵌套编码，所以最终 URL 会看到：
 * target_uid%2523123456
 * ============================================================
 */
/**
 * ============================================================
 * profile_inpage Response 是否存在超LIKE
 *
 * 优先判断页面实际展示的：
 * title_sub = "超LIKE"
 *
 * 同时兼容 scheme 中：
 * union_id=chao_like
 * union_id%3Dchao_like
 * union_id%253Dchao_like
 * ============================================================
 */
/*
 * 从 profile_inpage JSON 中提取“TA发布的”顶层帖子。
 *
 * 真实 Response 结构：
 * data.cards[].card_group[].mblog
 *
 * 这里故意只取顶层 mblog，不递归进入 retweeted_status，
 * 避免把转发原文当成该用户自己的超话帖子。
 */
/**
 * ============================================================
 * 游客模式请求用户 profile_inpage 并判断当前是否有超LIKE
 *
 * 返回：
 * {
 *   ok: true,
 *   hasSuperLike: true/false,
 *   url
 * }
 *
 * 请求失败时：
 * {
 *   ok: false,
 *   hasSuperLike: null,
 *   ...
 * }
 * ============================================================
 */
const SCAN_PROFILE_HARD_TIMEOUT_MS = 15000;

/**
 * ============================================================
 * Process Post Page
 * ============================================================
 */

/* ============================================================
 * Scan one monitor
 * ============================================================ */

async function scanOneSuperLikeMonitor(
  monitor,
  deleteUidSet,
  forceLocal = false,
  proxyFailureCount = 0,
  local418FallbackError = null
) {
  const MAX_PAGES =
    getScanMaxPages();

  const config =
    parseTopicHomepage(
      monitor.url
    );


  const workerProfileSuffix =
    SCAN_WORKER_MODE === 'fresh'
      ? (
          SCAN_WORKER_SOURCE
          || 'fresh'
        )
      : SCAN_WORKER_MODE;

  const profileDir =
    path.join(
      ROOT,
      'data',
      `superlike-browser-profile-scan-${workerProfileSuffix}`
    );

  let browser = null;
  let scanVisitorContext = null;
  let proxyAssignment = null;
  let delegatedToLocal = false;


  const startedAt =
    Date.now();


  const seenThisRun =
    new Set();

  const seenUidThisRun =
    new Set();

  /*
   * Scan 本轮 Profile 结果缓存：
   * 同一 UID 即使跨页再次出现，也不会重复请求个人 Profile。
   */
  const profileCache =
    new Map();

  const checkpoint =
    getScanCheckpoint(
      monitor.id
    );

  const storedResume =
    getScanResume(
      monitor.id
    );

  /*
   * Resume 必须属于当前正式 checkpoint。
   * checkpoint 已经推进过的旧游标绝不能继续使用。
   */
  const resume =
    storedResume
    &&
    String(
      storedResume.checkpoint_post_id
      || ''
    )
    ===
    String(
      checkpoint?.latest_post_id
      || ''
    )
      ? storedResume
      : null;

  if (
    storedResume
    &&
    !resume
  ) {
    clearScanResume(
      monitor.id
    );
  }

  let newestThisRound =
    null;


  const total = {
    found: 0,
    duplicateInRun: 0,
    existingInDb: 0,
    unknownComments: 0,
    commentsFull: 0,
    hasSuperLike: 0,
    deleteQueued: 0,
    target: 0,
    inserted: 0,
    replaced: 0,
    duplicateUidInRun: 0,
    profileChecked: 0,
    profileCached: 0,
    profileSuperLike: 0,
    profileFailed: 0
  };

  let pagesScanned =
    0;

  let stopReason =
    `达到最大 ${MAX_PAGES} 页`;

  /*
   * 只有确认本轮扫描边界是完整/安全的，才允许推进 checkpoint。
   *
   * 418、普通HTTP失败、异常中断：
   * 一律保留旧 checkpoint，避免下一轮跳过未扫描区间。
   */
  let checkpointSafeToAdvance =
    false;


  try {
    console.log('');
    console.log(
      '=============================================='
    );

    console.log(
      `SuperLike Monitor：${monitor.name}`
    );

    console.log(
      `真实超话首页：${config.homepage}`
    );

    console.log(
      `最新评论 flowId：${config.feedFlowId}`
    );

    console.log(
      `最多：${MAX_PAGES}页`
    );

    console.log(
      checkpoint
        ? `[SuperLike] 上次Checkpoint：${checkpoint.latest_created_at || '-'} / ${checkpoint.latest_post_id || '-'}`
        : '[SuperLike] 上次Checkpoint：无（首次运行）'
    );

    console.log(
      resume
        ? `[SuperLike][Resume] 发现断点 page=${resume.next_page}；本轮会先抓最新，再继续断点。`
        : '[SuperLike][Resume] 无断点，从最新开始。'
    );

    console.log(
      '=============================================='
    );


    proxyAssignment =
      (
        forceLocal
        ||
        SCAN_FORCE_LOCAL
      )
        ? {
            configured: false,
            raw: null,
            proxy: null,
            masked: 'LOCAL'
          }
        : await acquireScanProxyWaiting();

    const proxy =
      proxyAssignment.proxy;

    console.log(
      proxy
        ? `[SuperLike] 本轮优先使用健康代理：${proxyAssignment.masked}`
        : (
            SCAN_FORCE_LOCAL
              ? '[SuperLike] 当前Worker已配置强制本地IP'
              : '[SuperLike] 当前轮使用本地IP'
          )
    );

    browser =
      await chromium
        .launchPersistentContext(
          profileDir,
          {
            // 默认无窗口运行。
            // 如需临时显示浏览器窗口，可设置 SUPERLIKE_HEADLESS=0
            headless:
              process.env.SUPERLIKE_HEADLESS !== '0',

            ...(proxy ? { proxy } : {}),

            viewport: {
              width: 1280,
              height: 900
            }
          }
        );

    /*
     * Scan 本 Monitor 全程共享一个匿名游客 Context：
     * 第一个 UID 建立 Visitor/H5 会话后，后续 UID 直接复用，
     * 避免每个 UID 都重新初始化无痕浏览器环境。
     */
    const parentBrowser =
      browser.browser();

    if (
      parentBrowser
      &&
      typeof parentBrowser.newContext ===
        'function'
    ) {
      scanVisitorContext =
        await parentBrowser.newContext({
          viewport: {
            width: 1280,
            height: 900
          }
        });

      console.log(
        '[SuperLike][Profile游客模式] 已创建本Monitor共享游客Context；后续UID复用Visitor Cookie/会话。'
      );
    } else {
      console.log(
        '[SuperLike][Profile游客模式] 无法创建共享游客Context，本轮退回每UID独立游客Context。'
      );
    }


    /*
     * Scanner 只需要 HTML / JS / XHR / fetch。
     * 图片、视频、字体都不参与帖子解析，直接拦截，减少网络请求和内存占用。
     */
    await browser.route(
      '**/*',
      async route => {
        const type =
          route.request()
            .resourceType();

        if (
          type === 'image'
          ||
          type === 'media'
          ||
          type === 'font'
        ) {
          await route.abort();
          return;
        }

        await route.continue();
      }
    );


    const page =
      browser.pages()[0]
      ||
      await browser.newPage();


    console.log(
      '[SuperLike] 打开真实超话首页...'
    );


    const homepageResponse =
      await page.goto(
        config.homepage,
        {
          waitUntil:
            'domcontentloaded',

          timeout:
            proxy
              ? 15 * 1000
              : 60 * 1000
        }
      );


    await page.waitForTimeout(
      INITIAL_WAIT_MS
    );


    await assertPageNot418(
      page,
      homepageResponse
    );


    const directSectionWorker =
      SCAN_WORKER_MODE === 'fresh'
      &&
      SCAN_WORKER_SOURCE.startsWith(
        'section-'
      );

    /*
     * 三个专区 Fresh Worker 不再走：
     *   一级“最新” -> _feed -> 总流“最新发帖” -> _sort_time
     *
     * 它们只需要先打开真实超话首页建立 weibo.com 页面会话，
     * 随后由 scanTagSection() 直接请求自己的 tag_status_sort 第一页。
     *
     * fresh-latest / history 仍保留原来的总流初始化流程。
     */
    let feedResult = null;
    let sortTimeFlowId = null;
    let firstSortTimeResult = null;
    let sortTimeRequestTemplateUrl = null;
    let sortTimeRequestTemplateHeaders = {};
    let current = null;
    let logicalPageNumber = 1;

    if (directSectionWorker) {
      console.log(
        `[SuperLike][专区直达] Worker=${SCAN_WORKER_SOURCE} | 已打开超话首页；跳过 _feed / 总流最新发帖 _sort_time，直接进入当前专区“最新发帖”扫描。`
      );
    } else {
      /*
       * 只走微博真实前端路径：
       * 先监听 _feed，再点击一级“最新”。
       *
       * 已确认：找不到一级“最新”时，直接请求 _feed 没有救援价值。
       * 因此不再做 _feed fallback：
       * - 代理环境：直接判定当前代理页面不可用，淘汰并换代理；
       * - 本地IP：直接结束当前 Monitor，等待下一轮。
       */
      const feedWaiter =
        waitForChaohuaResponse(
          page,
          config.feedFlowId,
          FEED_WAIT_MS
        );
  
  
      console.log(
        '[SuperLike] 点击一级“最新”...'
      );
  
  
      const clicked =
        await clickPrimaryLatest(
          page
        );
  
  
      if (!clicked) {
        stopReason =
          '15秒内仍未找到一级“最新”Tab';
  
        if (
          proxyAssignment?.raw
          &&
          !forceLocal
        ) {
          throw new Error(
            'PROXY_PAGE_INVALID：15秒内仍未找到一级“最新”Tab'
          );
        }
  
        console.error(
          `[SuperLike] ${stopReason}；当前为本地IP，不直接请求 _feed。`
        );
  
        return;
      }
  
  
      feedResult =
        await feedWaiter;
  
  
      if (feedResult?.http418) {
        throw new Weibo418Error(
          '_feed 返回 HTTP 418'
        );
      }
  
  
      if (!feedResult) {
        stopReason =
          '点击一级“最新”后未捕获到 _feed';
  
        if (
          proxyAssignment?.raw
          &&
          !forceLocal
        ) {
          throw new Error(
            'PROXY_PAGE_INVALID：点击一级“最新”后未捕获到 _feed'
          );
        }
  
        console.error(
          `[SuperLike] ${stopReason}；当前为本地IP，不直接请求 _feed。`
        );
  
        return;
      }
  
  
      console.log(
        `[SuperLike] _feed 第一页成功：${feedResult.url}`
      );
  
  
      /*
       * 从 _feed Response 获取“最新发帖” flowId
       */
      sortTimeFlowId =
        extractLatestPostFlowId(
          feedResult.json
        );
  
  
      if (!sortTimeFlowId) {
        stopReason =
          '_feed Response 中没有找到“最新发帖”containerid';
  
        console.error(
          `[SuperLike] ${stopReason}`
        );
  
        return;
      }
  
  
      console.log(
        `[SuperLike] 从 _feed Response 找到“最新发帖” flowId：${sortTimeFlowId}`
      );
  
  
      /*
       * 关键：
       * 监听器必须先挂，再点击 DOM。
       */
      const firstSortTimeWaiter =
        waitForChaohuaResponse(
          page,
          sortTimeFlowId,
          FEED_WAIT_MS
        );
  
  
      await clickLatestPostTab(
        page
      );
  
  
      firstSortTimeResult =
        await firstSortTimeWaiter;
  
  
      if (!firstSortTimeResult) {
        stopReason =
          '点击“最新发帖”后未捕获到 sort_time 第一页';
  
        console.error(
          `[SuperLike] ${stopReason}`
        );
  
        return;
      }
  
  
      console.log(
        `[SuperLike] sort_time 第一页成功：${firstSortTimeResult.url}`
      );
  
  
      /*
       * 后续分页始终以微博前端真实发出的第一页 sort_time 请求为模板。
       */
      sortTimeRequestTemplateUrl =
        firstSortTimeResult.url;
  
      sortTimeRequestTemplateHeaders =
        firstSortTimeResult?.requestHeaders
        ||
        {};
  
  
      current =
        firstSortTimeResult;
  
      logicalPageNumber = 1;
  
  
    }

    /*
     * Fresh-first：
     * 先扫“最新发帖”的 fresh 区段，再立即扫“最新评论”，
     * 最后才允许切到旧 Resume 补历史。
     * 这样两条最新数据源都不会被几千页历史 Resume 卡住。
     */
    let switchedToResume =
      false;

    let resumeStartedAt =
      null;

    const chinaHour =
      Number(
        new Intl.DateTimeFormat(
          'en-US',
          {
            timeZone:
              'Asia/Shanghai',
            hour:
              '2-digit',
            hour12:
              false
          }
        ).format(
          new Date()
        )
      );

    const nightPeak =
      chinaHour >= 19;

    const freshFirstPages =
      nightPeak
        ? NIGHT_FRESH_FIRST_PAGES
        : DAY_FRESH_FIRST_PAGES;

    if (resume) {
      console.log(
        `[SuperLike][FreshFirst] ${nightPeak ? '晚高峰' : '白天'}策略：检测到 Resume page=${resume.next_page}；本轮先扫描最新 ${freshFirstPages} 页${nightPeak ? '，晚高峰暂停历史 Resume' : '，再继续旧 Resume'}。`
      );
    }


    const freshCollectedPosts = [];
    const freshCollectedPostIds = new Set();
    let freshPoolFlushed = false;
    let latestCommentsPromise = null;
    let latestCommentsError = null;

    const tagSectionPromises =
      new Map();

    /*
     * Fresh Pool 分批即时处理：
     * 最新发帖每10页 + 三个专区各10页视为一个批次。
     * 达到 10/20/30... 页屏障时，立即处理截至当时尚未处理的 Fresh Pool。
     * 某来源若因 checkpoint / 无下一页提前结束，则视为该来源已就绪，
     * 避免其它来源永远等不到屏障。
     */
    const FRESH_BATCH_PAGES = 10;

    const freshSourcePages = {
      'latest-posts': 0,
      ...Object.fromEntries(
        TAG_SECTION_SOURCES.map(
          source => [source.key, 0]
        )
      )
    };

    const freshSourceDone = {
      'latest-posts': false,
      ...Object.fromEntries(
        TAG_SECTION_SOURCES.map(
          source => [source.key, false]
        )
      )
    };

    let freshProcessedIndex = 0;
    let freshBatchNumber = 0;
    let freshBatchProcessing =
      Promise.resolve();

    let tagHistoryResumeDone =
      false;

    function collectFreshPage(
      json,
      source,
      checkpointForPage = null
    ) {
      const posts = findPosts(json);
      const stats = {
        found: posts.length,
        collected: 0,
        duplicateInPool: 0,
        filteredSuperLike: 0,
        filteredKnownSuperLike: 0,
        checkpointReached: false,
        pageFullyAtOrBeforeCheckpoint: false,
        pageHasNoPosts: posts.length === 0,
        newestSeen: getNewestPostInfo(posts)
      };

      if (checkpointForPage) {
        const checkpointMs =
          Number(checkpointForPage.latest_created_at_ms);

        let comparablePosts = 0;
        let allComparable =
          Number.isFinite(checkpointMs)
          && posts.length > 0;
        let allAtOrBefore =
          allComparable;

        for (const post of posts) {
          const postId = getPostId(post);

          if (!postId) {
            continue;
          }

          if (
            shouldStopAtCheckpoint(
              post,
              checkpointForPage
            )
          ) {
            stats.checkpointReached = true;
          }

          if (allComparable) {
            const createdAtMs =
              parsePostCreatedAtMs(post);

            if (
              !Number.isFinite(
                Number(createdAtMs)
              )
            ) {
              allComparable = false;
              allAtOrBefore = false;
            } else {
              comparablePosts++;

              if (
                Number(createdAtMs)
                >
                checkpointMs
              ) {
                allAtOrBefore = false;
              }
            }
          }
        }

        stats.pageFullyAtOrBeforeCheckpoint =
          comparablePosts > 0
          &&
          allComparable
          &&
          allAtOrBefore;
      }

      for (const post of posts) {
        const postId = getPostId(post);

        if (!postId) {
          continue;
        }

        if (
          freshCollectedPostIds.has(
            postId
          )
        ) {
          stats.duplicateInPool++;
          continue;
        }

        /*
         * Fresh Pool 前置过滤：
         * 1. feed 已明确带 chao_like -> 不进入 Fresh Pool；
         * 2. UID 已经在 superlike_users -> 不进入 Fresh Pool。
         *
         * 注意：checkpoint / 时间边界统计在上面的原始 posts 循环中完成，
         * 所以前置过滤不会影响 Fresh 是否已经跨过上一轮边界的判断。
         */
        if (hasSuperLike(post)) {
          const uid =
            getUid(post);

          if (uid) {
            saveSuperLikeUser(
              monitor.id,
              uid
            );

            deletePostsByUidWithLog(
              uid,
              'FEED_SUPERLIKE_ICON'
            );
          }

          stats.filteredSuperLike++;
          continue;
        }

        const uid =
          getUid(post);

        if (
          uid
          &&
          isSuperLikeUser(uid)
        ) {
          stats.filteredKnownSuperLike++;
          continue;
        }

        freshCollectedPostIds.add(postId);

        freshCollectedPosts.push({
          post,
          source: String(source || 'unknown')
        });

        stats.collected++;
      }

      return stats;
    }

    async function scanTagSectionHistoryBudget() {
      if (tagHistoryResumeDone) {
        return;
      }

      tagHistoryResumeDone = true;

      const deadline =
        Date.now()
        + RESUME_TIME_BUDGET_MS;

      const historyCutoffMs =
        Date.now()
        - HISTORY_MAX_AGE_HOURS
          * 60 * 60 * 1000;

      const queue =
        TAG_SECTION_SOURCES
          .map(
            source => ({
              source,
              resume:
                getScanSourceResume(
                  monitor.id,
                  source.key
                )
            })
          )
          .filter(
            item =>
              item.resume
              &&
              item.resume.next_since_id
          );

      if (queue.length === 0) {
        console.log(
          '[SuperLike][分区历史Resume] 当前没有需要补扫的分区历史。'
        );
        return;
      }

      console.log(
        `[SuperLike][分区历史Resume] fresh已入库；开始补历史，${queue.length}个分区共享${Math.round(RESUME_TIME_BUDGET_MS / 60000)}分钟预算。`
      );

      const requestHeaders =
        firstSortTimeResult?.requestHeaders
        || feedResult?.requestHeaders
        || {};

      async function worker() {
        while (
          queue.length > 0
          &&
          Date.now() < deadline
        ) {
          const item =
            queue.shift();

          if (!item) {
            break;
          }

          const {
            source
          } = item;

          let resume =
            item.resume;

          let historyPage = 0;
          let consecutiveOldPages = 0;

          while (
            resume
            &&
            resume.next_since_id
            &&
            Date.now() < deadline
          ) {
            historyPage++;

            const params = {
              page:
                resume.next_page,
              since_id:
                resume.next_since_id,
              max_id:
                resume.next_max_id
                ?? '0',
              count:
                resume.next_count
                ?? '15',
              page_common_ext:
                resume.next_page_common_ext
                ?? 'topicPrompt:1|page:tag_status_sort=1|hide_page:1'
            };

            const url =
              buildTagSectionUrl(
                source.flowId,
                params
              );

            const result =
              await fetchChaohuaInPage(
                page,
                url,
                requestHeaders
              );

            if (
              result.httpStatus === 418
            ) {
              throw new Weibo418Error(
                `${source.name} 历史Resume返回 HTTP 418`
              );
            }

            if (!result.ok) {
              console.log(
                `[SuperLike][分区历史Resume失败] ${source.name} | HTTP=${result.httpStatus ?? '-'} | 保留cursor，下轮继续。`
              );
              break;
            }

            pagesScanned++;

            await saveScanResponseJson(
              result.json,
              `${source.key}-resume`
            );

            const historyPosts =
              findPosts(
                result.json
              );

            const ageState =
              getHistoryPageAgeState(
                historyPosts,
                historyCutoffMs
              );

            const pageStats =
              await processPagePosts(
                monitor.id,
                result.json,
                seenThisRun,
                seenUidThisRun,
                deleteUidSet,
                null,
                browser,
                config,
                profileCache,
                scanVisitorContext,
                historyPosts,
                historyCutoffMs
              );

            for (
              const key
              of Object.keys(total)
            ) {
              if (
                typeof pageStats[key]
                === 'number'
              ) {
                total[key] +=
                  pageStats[key]
                  || 0;
              }
            }

            const nextParams =
              extractTagNextPageParams(
                result.json
              );

            console.log(
              [
                `[分区历史Resume ${source.name} #${historyPage}]`,
                `Post=${pageStats.found}`,
                `Profile查=${pageStats.profileChecked}`,
                `新增=${pageStats.inserted}`,
                `更新UID=${pageStats.replaced}`,
                `过期跳过=${pageStats.olderThanMinCreatedAt || 0}`,
                `剩余预算=${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))}秒`
              ].join(' | ')
            );

            if (ageState.fullyOlder) {
              consecutiveOldPages++;
            } else {
              consecutiveOldPages = 0;
            }

            if (
              consecutiveOldPages
              >= HISTORY_OLD_PAGE_THRESHOLD
            ) {
              clearScanSourceResume(
                monitor.id,
                source.key
              );

              console.log(
                `[SuperLike][分区历史48h完成] ${source.name} 连续 ${HISTORY_OLD_PAGE_THRESHOLD} 页越过最近 ${HISTORY_MAX_AGE_HOURS} 小时边界，清除Resume；更老数据不再扫描。`
              );

              break;
            }

            if (!nextParams) {
              clearScanSourceResume(
                monitor.id,
                source.key
              );

              console.log(
                `[SuperLike][分区历史Resume完成] ${source.name} 已无下一页，清除Resume。`
              );

              break;
            }

            saveScanSourceResume(
              monitor.id,
              source.key,
              source.flowId,
              nextParams
            );

            resume =
              getScanSourceResume(
                monitor.id,
                source.key
              );

            if (
              PAGE_DELAY_MS > 0
              &&
              Date.now() < deadline
            ) {
              await page.waitForTimeout(
                Math.min(
                  PAGE_DELAY_MS,
                  Math.max(
                    0,
                    deadline - Date.now()
                  )
                )
              );
            }
          }
        }
      }

      const workers =
        Array.from(
          {
            length:
              Math.min(
                TAG_SECTION_CONCURRENCY,
                queue.length
              )
          },
          () => worker()
        );

      await Promise.all(
        workers
      );

      if (
        Date.now() >= deadline
      ) {
        console.log(
          '[SuperLike][分区历史Resume] 5分钟预算已到，保留各分区当前cursor，下轮继续。'
        );
      }
    }


    function freshBatchReady(
      targetPages
    ) {
      return Object.keys(
        freshSourcePages
      ).every(
        key =>
          freshSourceDone[key]
          ||
          freshSourcePages[key] >= targetPages
      );
    }


    async function processFreshPoolSlice(
      trigger,
      force = false
    ) {
      /*
       * 串行化多个来源几乎同时触发的 flush，
       * 防止同一批 Fresh Post 被重复处理。
       */
      freshBatchProcessing =
        freshBatchProcessing.then(
          async () => {
            const nextTargetPages =
              (freshBatchNumber + 1)
              * FRESH_BATCH_PAGES;

            if (
              !force
              &&
              !freshBatchReady(
                nextTargetPages
              )
            ) {
              return;
            }

            const endIndex =
              freshCollectedPosts.length;

            if (
              endIndex <= freshProcessedIndex
            ) {
              if (!force) {
                freshBatchNumber++;
              }

              console.log(
                `[SuperLike][Fresh批次] trigger=${trigger} | 批次=${freshBatchNumber || 'final'} | 没有新增Fresh Post需要处理`
              );

              return;
            }

            const posts =
              freshCollectedPosts
                .slice(
                  freshProcessedIndex,
                  endIndex
                )
                .map(
                  item => item.post
                );

            const startIndex =
              freshProcessedIndex;

            /*
             * 先锁定本批边界。
             * 其它采集协程可以继续向 freshCollectedPosts 尾部追加，
             * 新追加的数据留给下一批，不会和本批重复。
             */
            freshProcessedIndex =
              endIndex;

            if (!force) {
              freshBatchNumber++;
            }

            console.log(
              [
                '[SuperLike][Fresh批次开始]',
                `trigger=${trigger}`,
                `批次=${force ? 'final' : freshBatchNumber}`,
                `本批Post=${posts.length}`,
                `池区间=${startIndex + 1}-${endIndex}`,
                `页进度=${Object.entries(freshSourcePages).map(([key, value]) => `${key}:${value}`).join(',')}`
              ].join(' | ')
            );

            const freshStats = {
              found: 0,
              duplicateInRun: 0,
              duplicateUidInRun: 0,
              existingInDb: 0,
              unknownComments: 0,
              commentsFull: 0,
              hasSuperLike: 0,
              deleteQueued: 0,
              target: 0,
              inserted: 0,
              replaced: 0,
              profileChecked: 0,
              profileCached: 0,
              profileSuperLike: 0,
              profileFailed: 0
            };

            for (
              let i = 0;
              i < posts.length;
              i += SCAN_PROFILE_CONCURRENCY
            ) {
              const chunk =
                posts.slice(
                  i,
                  i + SCAN_PROFILE_CONCURRENCY
                );

              const results =
                await Promise.all(
                  chunk.map(
                    post =>
                      processPagePosts(
                        monitor.id,
                        null,
                        seenThisRun,
                        seenUidThisRun,
                        deleteUidSet,
                        null,
                        browser,
                        config,
                        profileCache,
                        scanVisitorContext,
                        [post]
                      )
                  )
                );

              for (
                const result
                of results
              ) {
                for (
                  const key
                  of Object.keys(freshStats)
                ) {
                  if (
                    typeof result?.[key]
                    === 'number'
                  ) {
                    freshStats[key] +=
                      result[key]
                      || 0;
                  }
                }
              }
            }

            for (
              const key
              of Object.keys(total)
            ) {
              if (
                typeof freshStats[key]
                === 'number'
              ) {
                total[key] +=
                  freshStats[key]
                  || 0;
              }
            }

            console.log(
              [
                '[SuperLike][Fresh批次完成]',
                `批次=${force ? 'final' : freshBatchNumber}`,
                `Post=${freshStats.found}`,
                `评论>=21=${freshStats.commentsFull}`,
                `SuperLike=${freshStats.hasSuperLike}`,
                `Profile查=${freshStats.profileChecked}`,
                `Profile命中=${freshStats.profileSuperLike}`,
                `Profile失败=${freshStats.profileFailed}`,
                `新增=${freshStats.inserted}`,
                `更新UID=${freshStats.replaced}`
              ].join(' | ')
            );
          }
        );

      return freshBatchProcessing;
    }


    async function flushFreshPool(trigger) {
      if (freshPoolFlushed) {
        return;
      }

      /*
       * 最终 flush 才等待所有分区结束。
       * 中途的 10页屏障不会再等 30 页全部采集完。
       */
      if (
        tagSectionPromises.size > 0
      ) {
        await Promise.all(
          Array.from(
            tagSectionPromises.values()
          )
        );
      }

      freshSourceDone['latest-posts'] =
        true;

      for (
        const source
        of TAG_SECTION_SOURCES
      ) {
        freshSourceDone[source.key] =
          true;
      }

      await processFreshPoolSlice(
        trigger,
        true
      );

      freshPoolFlushed = true;

      if (
        SCAN_WORKER_MODE !== 'fresh'
      ) {
        await scanTagSectionHistoryBudget();
      }
    }


    async function scanLatestHistoryBudget() {
      if (!resume) {
        console.log(
          '[SuperLike][History][latest-posts] 当前没有 Resume。'
        );
        return;
      }

      const deadline =
        Date.now()
        + RESUME_TIME_BUDGET_MS;

      const historyCutoffMs =
        Date.now()
        - HISTORY_MAX_AGE_HOURS
          * 60 * 60 * 1000;

      let consecutiveOldPages = 0;

      console.log(
        `[SuperLike][History][latest-posts] 仅补最近 ${HISTORY_MAX_AGE_HOURS} 小时；连续 ${HISTORY_OLD_PAGE_THRESHOLD} 个完整旧页后停止并清除Resume。`
      );

      let latestResume =
        getScanResume(
          monitor.id
        );

      let historyPage = 0;

      while (
        latestResume
        &&
        Date.now() < deadline
      ) {
        historyPage++;

        const params = {
          page:
            Number(
              latestResume.next_page
            ),
          since_id:
            latestResume.next_since_id
            ?? null,
          max_id:
            latestResume.next_max_id
            ?? '0'
        };

        const historyUrl =
          buildChaohuaUrl(
            latestResume.sort_time_flow_id
            || sortTimeFlowId,
            params,
            latestResume.template_url
            || sortTimeRequestTemplateUrl
          );

        const result =
          await fetchChaohuaInPage(
            page,
            historyUrl,
            sortTimeRequestTemplateHeaders
          );

        if (
          result.httpStatus === 418
        ) {
          throw new Weibo418Error(
            'History latest-posts 返回 HTTP 418'
          );
        }

        if (!result.ok) {
          console.log(
            `[SuperLike][History][latest-posts失败] page=${params.page} | HTTP=${result.httpStatus ?? '-'} | ${result.error || result.text || '-'} | 保留Resume`
          );
          break;
        }

        pagesScanned++;

        await saveScanResponseJson(
          result.json,
          'latest-posts-history'
        );

        const historyPosts =
          findPosts(
            result.json
          );

        const ageState =
          getHistoryPageAgeState(
            historyPosts,
            historyCutoffMs
          );

        const pageStats =
          await processPagePosts(
            monitor.id,
            result.json,
            seenThisRun,
            seenUidThisRun,
            deleteUidSet,
            null,
            browser,
            config,
            profileCache,
            scanVisitorContext,
            historyPosts,
            historyCutoffMs
          );

        for (
          const key
          of Object.keys(total)
        ) {
          if (
            typeof pageStats[key]
            === 'number'
          ) {
            total[key] +=
              pageStats[key]
              || 0;
          }
        }

        console.log(
          [
            `[History latest-posts #${historyPage}]`,
            `page=${params.page}`,
            `Post=${pageStats.found}`,
            `Profile查=${pageStats.profileChecked}`,
            `新增=${pageStats.inserted}`,
            `更新UID=${pageStats.replaced}`,
            `过期跳过=${pageStats.olderThanMinCreatedAt || 0}`
          ].join(' | ')
        );

        if (ageState.fullyOlder) {
          consecutiveOldPages++;

          console.log(
            `[SuperLike][History][48h边界] page=${params.page} 整页早于最近${HISTORY_MAX_AGE_HOURS}小时/为空页，连续旧页=${consecutiveOldPages}/${HISTORY_OLD_PAGE_THRESHOLD}`
          );
        } else {
          if (consecutiveOldPages > 0) {
            console.log(
              `[SuperLike][History][48h边界] page=${params.page} 仍有最近${HISTORY_MAX_AGE_HOURS}小时内帖子，连续旧页 ${consecutiveOldPages} -> 0`
            );
          }

          consecutiveOldPages = 0;
        }

        if (
          consecutiveOldPages
          >= HISTORY_OLD_PAGE_THRESHOLD
        ) {
          clearScanResume(
            monitor.id
          );

          console.log(
            `[SuperLike][History][48h完成] 已连续 ${HISTORY_OLD_PAGE_THRESHOLD} 页越过最近 ${HISTORY_MAX_AGE_HOURS} 小时边界，清除 latest-posts Resume；更老数据不再扫描。`
          );
          break;
        }

        const nextParams =
          extractNextPageParams(
            result.json
          );

        if (!nextParams) {
          clearScanResume(
            monitor.id
          );

          console.log(
            '[SuperLike][History][latest-posts] 已无下一页，清除Resume。'
          );
          break;
        }

        saveScanResume(
          monitor.id,
          checkpoint,
          latestResume.sort_time_flow_id
          || sortTimeFlowId,
          latestResume.template_url
          || sortTimeRequestTemplateUrl,
          nextParams
        );

        latestResume =
          getScanResume(
            monitor.id
          );

        if (
          PAGE_DELAY_MS > 0
          &&
          Date.now() < deadline
        ) {
          await page.waitForTimeout(
            Math.min(
              PAGE_DELAY_MS,
              Math.max(
                0,
                deadline - Date.now()
              )
            )
          );
        }
      }
    }


    function scanTagSection(
      source
    ) {
      if (
        !source
        ||
        !source.flowId
      ) {
        return Promise.resolve();
      }

      if (
        tagSectionPromises.has(
          source.key
        )
      ) {
        return tagSectionPromises.get(
          source.key
        );
      }

      const promise =
        (async () => {
          let sourceResume =
            getScanSourceResume(
              monitor.id,
              source.key
            );

          const sourceCheckpoint =
            getScanSourceCheckpoint(
              monitor.id,
              source.key
            );

          let newestSourceThisRound =
            null;

          let sourceOldTimePageStreak = 0;

          if (
            sourceResume
            &&
            String(
              sourceResume.flow_id
              || ''
            )
            !==
            String(
              source.flowId
            )
          ) {
            clearScanSourceResume(
              monitor.id,
              source.key
            );

            sourceResume = null;
          }

          console.log(
            sourceCheckpoint
              ? `[SuperLike][分区Fresh] ${source.name} 上轮时间checkpoint=${sourceCheckpoint.latest_created_at || '-'}；PostID=${sourceCheckpoint.latest_post_id}仅作辅助，连续4个完整旧页即停止。`
              : `[SuperLike][分区Fresh] ${source.name} 首次运行；先扫描 ${freshFirstPages} 页建立checkpoint，历史由Resume继续补。`
          );

          const requestHeaders =
            firstSortTimeResult?.requestHeaders
            || feedResult?.requestHeaders
            || {};

          let currentUrl =
            buildTagSectionUrl(
              source.flowId
            );

          let currentResult =
            await fetchChaohuaInPage(
              page,
              currentUrl,
              requestHeaders
            );

          if (
            currentResult.httpStatus === 418
          ) {
            throw new Weibo418Error(
              `${source.name} 第一页返回 HTTP 418`
            );
          }

          if (!currentResult.ok) {
            logTagSectionDiagnostic(
              source,
              currentResult,
              proxyAssignment,
              '第一页'
            );

            if (
              isChaohuaBusy303403(
                currentResult
              )
            ) {
              console.log(
                `[SuperLike][分区暂时繁忙] ${source.name} 第一页返回 303403；本轮跳过该分区，不淘汰代理，下一轮自动重试。`
              );

              return;
            }

            throw new Error(
              `${source.name} 第一页请求失败：HTTP ${currentResult.httpStatus ?? '-'} ${currentResult.error || currentResult.text || ''}`
            );
          }

          let phase =
            'fresh';

          for (
            let sectionPageIndex = 1;
            sectionPageIndex <= TAG_SECTION_PAGES;
            sectionPageIndex++
          ) {
            pagesScanned++;

            await saveScanResponseJson(
              currentResult.json,
              phase === 'resume'
                ? `${source.key}-resume`
                : source.key
            );

            const sectionStats =
              collectFreshPage(
                currentResult.json,
                source.key,
                sourceCheckpoint
              );

            freshSourcePages[source.key] =
              Number(
                freshSourcePages[source.key]
                || 0
              ) + 1;

            await processFreshPoolSlice(
              `${source.key}-page-${sectionPageIndex}`
            );

            if (
              sectionStats.newestSeen
              &&
              (
                !newestSourceThisRound
                ||
                sectionStats.newestSeen.createdAtMs
                  > newestSourceThisRound.createdAtMs
              )
            ) {
              newestSourceThisRound =
                sectionStats.newestSeen;
            }

            if (sourceCheckpoint) {
              if (sectionStats.checkpointReached) {
                if (newestSourceThisRound) {
                  saveScanSourceCheckpoint(
                    monitor.id,
                    source.key,
                    newestSourceThisRound.postId,
                    newestSourceThisRound.createdAt,
                    newestSourceThisRound.createdAtMs
                  );
                }

                console.log(
                  `[SuperLike][分区Checkpoint] ${source.name} 辅助PostID命中 ${sourceCheckpoint.latest_post_id}；Fresh停止，新checkpoint=${newestSourceThisRound?.postId || '-'}。`
                );

                break;
              }

              const oldTimePage =
                sectionStats.pageFullyAtOrBeforeCheckpoint
                || sectionStats.pageHasNoPosts;

              if (oldTimePage) {
                sourceOldTimePageStreak++;

                console.log(
                  `[SuperLike][分区时间Checkpoint] ${source.name} 第${sectionPageIndex}页${sectionStats.pageHasNoPosts ? '为空页' : `全部 <= ${sourceCheckpoint.latest_created_at || '-'}`}；连续旧页=${sourceOldTimePageStreak}/4`
                );
              } else {
                if (sourceOldTimePageStreak > 0) {
                  console.log(
                    `[SuperLike][分区时间Checkpoint] ${source.name} 第${sectionPageIndex}页仍出现较新帖子；连续旧页 ${sourceOldTimePageStreak} -> 0`
                  );
                }

                sourceOldTimePageStreak = 0;
              }

              if (sourceOldTimePageStreak >= 4) {
                if (newestSourceThisRound) {
                  saveScanSourceCheckpoint(
                    monitor.id,
                    source.key,
                    newestSourceThisRound.postId,
                    newestSourceThisRound.createdAt,
                    newestSourceThisRound.createdAtMs
                  );
                }

                console.log(
                  `[SuperLike][分区时间Checkpoint] ${source.name} 连续4页已跨过上一轮时间边界 ${sourceCheckpoint.latest_created_at || '-'}；Fresh停止，新checkpoint=${newestSourceThisRound?.createdAt || '-'} / ${newestSourceThisRound?.postId || '-'}。`
                );

                break;
              }
            }

            console.log(
              [
                `[分区采集 ${source.name} ${phase === 'resume' ? 'Resume' : 'Fresh'} #${sectionPageIndex}]`,
                `Post=${sectionStats.found}`,
                `新收集=${sectionStats.collected}`,
                `池内重复=${sectionStats.duplicateInPool}`,
                `过滤超LIKE=${sectionStats.filteredSuperLike}`,
                `过滤已知UID=${sectionStats.filteredKnownSuperLike}`,
                `fresh池=${freshCollectedPosts.length}`
              ].join(' | ')
            );

            const nextParams =
              extractTagNextPageParams(
                currentResult.json
              );

            if (!nextParams) {
              clearScanSourceResume(
                monitor.id,
                source.key
              );

              if (newestSourceThisRound) {
                saveScanSourceCheckpoint(
                  monitor.id,
                  source.key,
                  newestSourceThisRound.postId,
                  newestSourceThisRound.createdAt,
                  newestSourceThisRound.createdAtMs
                );
              }

              console.log(
                `[SuperLike][分区采集] ${source.name} 已到末尾；推进checkpoint=${newestSourceThisRound?.postId || '-'}。`
              );

              break;
            }

            /*
             * 已进入 Resume 后，每处理成功一页就立刻保存“下一页”。
             * 进程中断或网络失败时，下轮可从未处理页继续。
             */
            if (
              phase === 'resume'
            ) {
              saveScanSourceResume(
                monitor.id,
                source.key,
                source.flowId,
                nextParams
              );
            }

            /*
             * 首次运行没有旧 checkpoint，无法判断“新增区间”边界。
             * 只扫原 freshFirstPages 建立起点；以后都改为追到 checkpoint。
             */
            if (
              !sourceCheckpoint
              &&
              sectionPageIndex >=
                freshFirstPages
            ) {
              saveScanSourceResume(
                monitor.id,
                source.key,
                source.flowId,
                nextParams
              );

              if (newestSourceThisRound) {
                saveScanSourceCheckpoint(
                  monitor.id,
                  source.key,
                  newestSourceThisRound.postId,
                  newestSourceThisRound.createdAt,
                  newestSourceThisRound.createdAtMs
                );
              }

              console.log(
                `[SuperLike][分区Checkpoint] ${source.name} 首次checkpoint=${newestSourceThisRound?.postId || '-'}；历史cursor已保存。`
              );

              break;
            }

            if (
              sectionPageIndex >=
              TAG_SECTION_PAGES
            ) {
              saveScanSourceResume(
                monitor.id,
                source.key,
                source.flowId,
                nextParams
              );

              console.log(
                `[SuperLike][分区Checkpoint] ${source.name} 扫到 ${TAG_SECTION_PAGES} 页仍未安全跨过旧时间checkpoint；旧边界不推进，保存cursor后下轮继续。`
              );

              break;
            }

            currentUrl =
              buildTagSectionUrl(
                source.flowId,
                nextParams
              );

            currentResult =
              await fetchChaohuaInPage(
                page,
                currentUrl,
                requestHeaders
              );

            if (
              currentResult.httpStatus === 418
            ) {
              throw new Weibo418Error(
                `${source.name} 下一页返回 HTTP 418`
              );
            }

            if (!currentResult.ok) {
              logTagSectionDiagnostic(
                source,
                currentResult,
                proxyAssignment,
                `第${sectionPageIndex + 1}页`
              );

              if (
                isChaohuaBusy303403(
                  currentResult
                )
              ) {
                console.log(
                  `[SuperLike][分区暂时繁忙] ${source.name} | 303403 | Resume已保留 | 本轮停止该分区，下一轮自动重试`
                );

                break;
              }

              console.log(
                `[SuperLike][分区采集失败] ${source.name} | HTTP=${currentResult.httpStatus ?? '-'} | ${currentResult.error || currentResult.text || '-'} | Resume已保留`
              );

              break;
            }

            if (
              PAGE_DELAY_MS > 0
            ) {
              await page.waitForTimeout(
                PAGE_DELAY_MS
              );
            }
          }

          console.log(
            `[SuperLike][分区采集完成] ${source.name}`
          );
        })()
        .catch(
          error => {
            console.log(
              `[SuperLike][分区采集异常] ${source.name} | ${error?.message || error}`
            );

            if (
              isWeibo418Error(
                error
              )
            ) {
              throw error;
            }

            return null;
          }
        )
        .finally(
          async () => {
            freshSourceDone[source.key] =
              true;

            console.log(
              `[SuperLike][Fresh批次] 来源完成：${source.name} | 页数=${freshSourcePages[source.key] || 0}`
            );

            await processFreshPoolSlice(
              `${source.key}-done`
            );
          }
        );

      tagSectionPromises.set(
        source.key,
        promise
      );

      return promise;
    }


    function scanLatestComments(
      trigger = 'parallel-fresh'
    ) {
      if (latestCommentsPromise) {
        return latestCommentsPromise;
      }

      latestCommentsPromise =
        (async () => {
          console.log(
            `[SuperLike][并发采集] 最新评论与最新发帖 fresh 同时采集；触发点=${trigger}`
          );

          console.log(
        `[SuperLike][最新评论] 开始独立扫描 _feed，最多 ${LATEST_COMMENTS_PAGES} 页；不使用发帖时间Checkpoint。`
      );
      
      let commentsCurrent = {
        url:
          feedResult.url,
        page:
          Number(feedResult.page || 1),
        json:
          feedResult.json
      };
      
      const commentsTemplateUrl =
        feedResult.url;
      
      const commentsTemplateHeaders =
        feedResult?.requestHeaders
        || {};
      
      for (
        let commentsPageIndex = 1;
        commentsPageIndex <= LATEST_COMMENTS_PAGES;
        commentsPageIndex++
      ) {
        pagesScanned++;
      
        await saveScanResponseJson(
          commentsCurrent.json,
          'latest-comments'
        );
      
        const commentsStats =
          collectFreshPage(
            commentsCurrent.json,
            'latest-comments',
            null
          );

        console.log(
          [
            `[最新评论采集 第${commentsCurrent.page || commentsPageIndex}页]`,
            `Post=${commentsStats.found}`,
            `新收集=${commentsStats.collected}`,
            `池内重复=${commentsStats.duplicateInPool}`,
            `fresh池=${freshCollectedPosts.length}`
          ].join(' | ')
        );

        if (
          commentsPageIndex >=
          LATEST_COMMENTS_PAGES
        ) {
          console.log(
            `[SuperLike][最新评论] 已扫描固定上限 ${LATEST_COMMENTS_PAGES} 页。`
          );
          break;
        }
      
        const commentsNextParams =
          extractNextPageParams(
            commentsCurrent.json
          );
      
        if (!commentsNextParams) {
          console.log(
            `[SuperLike][最新评论] 第${commentsCurrent.page || commentsPageIndex}页没有下一页参数，结束最新评论扫描。`
          );
          break;
        }
      
        const commentsNextUrl =
          buildChaohuaUrl(
            config.feedFlowId,
            commentsNextParams,
            commentsTemplateUrl
          );
      
        console.log(
          `[SuperLike][最新评论] 请求下一页 _feed：page=${commentsNextParams.page}`
        );
      
        let commentsNextResult =
          await fetchChaohuaInPage(
            page,
            commentsNextUrl,
            commentsTemplateHeaders
          );
      
        if (
          !commentsNextResult.ok
          &&
          commentsNextResult.httpStatus === null
        ) {
          console.log(
            `[SuperLike][最新评论慢重试] page=${commentsNextParams.page} | 前3次未拿到HTTP Response | 5000ms后最后重试一次`
          );
      
          await page.waitForTimeout(
            5000
          );
      
          commentsNextResult =
            await fetchChaohuaInPage(
              page,
              commentsNextUrl,
              commentsTemplateHeaders
            );
        }
      
        if (
          commentsNextResult.httpStatus === 418
        ) {
          throw new Weibo418Error(
            '最新评论 _feed 下一页返回 HTTP 418'
          );
        }
      
        if (!commentsNextResult.ok) {
          console.log(
            commentsNextResult.httpStatus === null
              ? `[SuperLike][最新评论] 下一页请求失败：${commentsNextResult.error || 'unknown error'}`
              : `[SuperLike][最新评论] 下一页 HTTP ${commentsNextResult.httpStatus}`
          );
      
          break;
        }
      
        commentsCurrent = {
          url:
            commentsNextUrl,
          page:
            Number(
              commentsNextParams.page
            ),
          json:
            commentsNextResult.json
        };
      
        if (
          PAGE_DELAY_MS > 0
        ) {
          await page.waitForTimeout(
            PAGE_DELAY_MS
          );
        }
      }
      
        })()
        .catch(
          error => {
            latestCommentsError = error;

            console.log(
              `[SuperLike][最新评论采集失败] ${error?.message || error}`
            );

            return null;
          }
        );

      return latestCommentsPromise;
    }

    /*
     * 与最新发帖 fresh 同时启动最新评论分页。
     * 两边都只做列表采集，不在翻页途中查 Profile。
     */
    /*
     * 最新评论不再作为 Scan 数据源。
     * feedResult 仍保留给页面初始化/现有上下文使用，但不采集 _feed 帖子。
     */
    console.log(
      '[SuperLike][最新评论] 已禁用，不参与帖子采集。'
    );

    /*
     * 分区不再全部同时打到同一个 Page/代理。
     * 默认最多 2 个分区并发；总最新仍独立同时运行。
     */
    if (SCAN_WORKER_MODE === 'history') {
      console.log('[SuperLike][History Worker] 只处理 Resume，不扫描 Fresh。');
      await scanLatestHistoryBudget();
      await scanTagSectionHistoryBudget();
      stopReason = 'History Worker 本轮预算完成';
      return;
    }

    if (
      SCAN_WORKER_MODE === 'fresh'
      &&
      SCAN_WORKER_SOURCE !== 'latest-posts'
    ) {
      freshSourceDone['latest-posts'] = true;
    }

    const sectionQueue =
      [...TAG_SECTION_SOURCES];

    const sectionWorkers =
      Array.from(
        {
          length:
            Math.min(
              TAG_SECTION_CONCURRENCY,
              sectionQueue.length
            )
        },
        async () => {
          while (
            sectionQueue.length > 0
          ) {
            const source =
              sectionQueue.shift();

            if (!source) {
              break;
            }

            await scanTagSection(
              source
            );
          }
        }
      );

    for (
      let workerIndex = 0;
      workerIndex < sectionWorkers.length;
      workerIndex++
    ) {
      tagSectionPromises.set(
        `__worker_${workerIndex}`,
        sectionWorkers[workerIndex]
      );
    }

    console.log(
      `[SuperLike][并发采集] WorkerMode=${SCAN_WORKER_MODE} Source=${SCAN_WORKER_SOURCE || '-'} | 最新发帖 / ${TAG_SECTION_SOURCES.map(item => item.name).join(' / ')} | 分区并发=${TAG_SECTION_CONCURRENCY} | 请求超时=30秒`
    );

    if (
      SCAN_WORKER_MODE === 'fresh'
      &&
      SCAN_WORKER_SOURCE !== 'latest-posts'
    ) {
      console.log(
        `[SuperLike][Fresh Worker] 仅扫描来源：${SCAN_WORKER_SOURCE}`
      );

      await Promise.all(
        sectionWorkers
      );

      freshSourceDone['latest-posts'] =
        true;

      await processFreshPoolSlice(
        `${SCAN_WORKER_SOURCE}-worker-done`,
        true
      );

      freshPoolFlushed =
        true;

      stopReason =
        `Fresh Worker ${SCAN_WORKER_SOURCE} 本轮完成`;

      return;
    }

    // Fresh 以发帖时间为主边界：连续4个完整旧页即可认为已跨过上一轮时间checkpoint。
    // post_id 仍作为更快的辅助命中；不要求微博必须再次返回同一个 post_id。
    const CHECKPOINT_OLD_PAGE_THRESHOLD = 4;
    let consecutiveOldCheckpointPages = 0;


    for (
      let batchPageIndex = 1;
      batchPageIndex <= MAX_PAGES;
      batchPageIndex++
    ) {
      const pageNumber =
        logicalPageNumber;
      pagesScanned++;


      await saveScanResponseJson(
        current.json,
        'latest-posts'
      );


      const collectingFresh =
        !switchedToResume
        &&
        !freshPoolFlushed;

      const pageStats =
        collectingFresh
          ? collectFreshPage(
              current.json,
              'latest-posts',
              checkpoint
            )
          : await processPagePosts(
              monitor.id,
              current.json,
              seenThisRun,
              seenUidThisRun,
              deleteUidSet,
              checkpoint,
              browser,
              config,
              profileCache,
              scanVisitorContext
            );

      if (collectingFresh) {
        freshSourcePages['latest-posts'] =
          Number(
            freshSourcePages['latest-posts']
            || 0
          ) + 1;

        await processFreshPoolSlice(
          `latest-posts-page-${pageNumber}`
        );
      }

      if (!collectingFresh) {
        for (
          const key
          of Object.keys(total)
        ) {
          if (
            typeof pageStats[key]
            === 'number'
          ) {
            total[key] +=
              pageStats[key]
              || 0;
          }
        }
      }


      if (
        pageStats.newestSeen
        &&
        (
          !newestThisRound
          ||
          pageStats.newestSeen.createdAtMs >
            newestThisRound.createdAtMs
        )
      ) {
        newestThisRound =
          pageStats.newestSeen;
      }


      console.log(
        collectingFresh
          ? [
              `[最新发帖采集 第${pageNumber}页]`,
              `Post=${pageStats.found}`,
              `新收集=${pageStats.collected}`,
              `池内重复=${pageStats.duplicateInPool}`,
              `fresh池=${freshCollectedPosts.length}`
            ].join(' | ')
          : [
              `[第${pageNumber}页]`,
              `Post=${pageStats.found}`,
              `同UID重复=${pageStats.duplicateUidInRun}`,
              `DB保留=${pageStats.existingInDb}`,
              `评论>=21=${pageStats.commentsFull}`,
              `SuperLike=${pageStats.hasSuperLike}`,
              `Profile查=${pageStats.profileChecked}`,
              `Profile缓存=${pageStats.profileCached}`,
              `Profile命中=${pageStats.profileSuperLike}`,
              `Profile失败=${pageStats.profileFailed}`,
              `待删UID=${pageStats.deleteQueued}`,
              `新增=${pageStats.inserted}`,
              `更新UID=${pageStats.replaced}`
            ].join(' | ')
      );


      if (
        pageStats.checkpointReached
      ) {
        stopReason =
          '已找到上一轮 latest_post_id';

        clearScanResume(
          monitor.id
        );

        console.log(
          '[SuperLike][Checkpoint] 辅助PostID命中：当前页已完整处理，停止请求下一页。'
        );

        checkpointSafeToAdvance =
          true;

        break;
      }


      if (checkpoint) {
        const safeOldBoundaryPage =
          pageStats.pageFullyAtOrBeforeCheckpoint
          || pageStats.pageHasNoPosts;

        if (safeOldBoundaryPage) {
          consecutiveOldCheckpointPages++;

          console.log(
            pageStats.pageHasNoPosts
              ? `[SuperLike][时间Checkpoint] 第${pageNumber}页为空页，连续旧页=${consecutiveOldCheckpointPages}/${CHECKPOINT_OLD_PAGE_THRESHOLD}`
              : `[SuperLike][时间Checkpoint] 第${pageNumber}页全部 <= ${checkpoint.latest_created_at || '-'}，连续旧页=${consecutiveOldCheckpointPages}/${CHECKPOINT_OLD_PAGE_THRESHOLD}`
          );
        } else {
          if (consecutiveOldCheckpointPages > 0) {
            console.log(
              `[SuperLike][时间Checkpoint] 第${pageNumber}页仍有 > ${checkpoint.latest_created_at || '-'} 的帖子，连续旧页 ${consecutiveOldCheckpointPages} -> 0`
            );
          }

          consecutiveOldCheckpointPages = 0;
        }

        if (
          consecutiveOldCheckpointPages >=
          CHECKPOINT_OLD_PAGE_THRESHOLD
        ) {
          stopReason =
            `连续 ${CHECKPOINT_OLD_PAGE_THRESHOLD} 页均为空页或整页 <= checkpoint 时间`;

          console.log(
            `[SuperLike][时间Checkpoint] 已安全跨过上一轮时间边界：${checkpoint.latest_created_at || '-'}；${stopReason}，停止Fresh。`
          );

          checkpointSafeToAdvance =
            true;

          clearScanResume(
            monitor.id
          );

          break;
        }
      }


      if (
        batchPageIndex >=
        MAX_PAGES
      ) {
        stopReason =
          `第三重兜底：达到最大 ${MAX_PAGES} 页`;

        /*
         * 首次运行没有旧 checkpoint，达到配置上限后可以建立新的 checkpoint。
         * 已有旧 checkpoint 时，如果只是撞到最大页数但仍没追到旧边界，
         * 说明中间可能还有未扫描数据，因此绝不能推进 checkpoint。
         */
        checkpointSafeToAdvance =
          !checkpoint;

        /*
         * 已有 checkpoint 时达到单批50页，不丢进度。
         * 下面会在拿到 nextParams 后保存 Resume；
         * 因此这里不能提前 break。
         */
        if (!checkpoint) {
          break;
        }
      }


      /*
       * Fresh-first 阶段结束后，再跳回旧 Resume 继续补历史。
       * 只切一次；Resume 阶段继续受本轮 MAX_PAGES 总上限约束。
       */
      if (
        false
        &&
        resume
        &&
        !nightPeak
        &&
        !switchedToResume
        &&
        batchPageIndex >=
          freshFirstPages
      ) {
        await flushFreshPool(
          'before-history-resume'
        );

        const resumeParams = {
          page:
            Number(resume.next_page),

          since_id:
            resume.next_since_id
            ?? null,

          max_id:
            resume.next_max_id
            ?? '0'
        };

        const resumeUrl =
          buildChaohuaUrl(
            resume.sort_time_flow_id
            || sortTimeFlowId,
            resumeParams,
            sortTimeRequestTemplateUrl
          );

        console.log(
          `[SuperLike][FreshFirst] 最新区段已处理 ${freshFirstPages} 页；现在切回 Resume page=${resumeParams.page}。`
        );

        const resumeResult =
          await fetchChaohuaInPage(
            page,
            resumeUrl,
            sortTimeRequestTemplateHeaders
          );

        if (
          resumeResult.httpStatus === 418
        ) {
          throw new Weibo418Error(
            'Resume sort_time 返回 HTTP 418'
          );
        }

        if (!resumeResult.ok) {
          throw new Error(
            `Resume sort_time HTTP ${resumeResult.httpStatus ?? '-'}：${resumeResult.error || resumeResult.text || '请求失败'}`
          );
        }

        current = {
          url:
            resumeUrl,
          page:
            resumeParams.page,
          json:
            resumeResult.json
        };

        logicalPageNumber =
          resumeParams.page;

        switchedToResume =
          true;

        resumeStartedAt =
          Date.now();

        console.log(
          `[SuperLike][Resume] 历史补扫时间上限=${Math.round(RESUME_TIME_BUDGET_MS / 60000)}分钟。`
        );

        consecutiveOldCheckpointPages =
          0;

        continue;
      }


      if (
        false
        &&
        nightPeak
        &&
        resume
        &&
        !switchedToResume
        &&
        batchPageIndex >=
          freshFirstPages
      ) {
        await flushFreshPool(
          'night-fresh-complete'
        );

        stopReason =
          `晚高峰最新区段已处理 ${freshFirstPages} 页，暂停历史 Resume`;

        console.log(
          `[SuperLike][FreshFirst] ${stopReason}；保留 Resume page=${resume.next_page}，结束本轮。`
        );

        break;
      }


      /*
       * 没有历史 Resume 时，也在 fresh 区段完成后先插入最新评论，
       * 然后再继续 sort_time 后续页。
       */
      if (
        false
        &&
        !resume
        &&
        !freshPoolFlushed
        &&
        batchPageIndex >=
          freshFirstPages
      ) {
        await flushFreshPool(
          'fresh-complete-no-resume'
        );
      }


      /*
       * 下一页改为直接 AJAX：
       *
       * 从当前 sort_time JSON 的 moreInfo.params 读取
       * page / since_id / max_id，
       * 然后在已经打开的 weibo.com 页面上下文里直接 fetch。
       *
       * 不再滚动页面，不再触发图片/推荐/埋点等额外请求。
       */
      const nextParams =
        extractNextPageParams(
          current.json
        );


      if (!nextParams) {
        stopReason =
          `第${pageNumber}页没有下一页参数`;

        console.log(
          `[SuperLike] ${stopReason}`
        );

        checkpointSafeToAdvance =
          true;

        clearScanResume(
          monitor.id
        );

        break;
      }


      /*
       * 当前页已经完整处理成功，此时才把“下一页 cursor”落库。
       * 所以即使下一页请求失败/进程退出，重启后也从未处理页继续。
       */
      if (
        checkpoint
        &&
        (
          !resume
          ||
          switchedToResume
        )
      ) {
        saveScanResume(
          monitor.id,
          checkpoint,
          sortTimeFlowId,
          sortTimeRequestTemplateUrl,
          nextParams
        );

        console.log(
          `[SuperLike][Resume] 已保存下一页断点：page=${nextParams.page}`
        );
      }


      if (
        switchedToResume
        &&
        resumeStartedAt
        &&
        Date.now() - resumeStartedAt
          >= RESUME_TIME_BUDGET_MS
      ) {
        stopReason =
          `历史 Resume 已补扫 ${Math.round(RESUME_TIME_BUDGET_MS / 60000)} 分钟，已保存 Resume page=${nextParams.page}`;

        console.log(
          `[SuperLike][Resume] ${stopReason}；结束本轮，下一轮仍先抓最新数据。`
        );

        break;
      }


      if (
        batchPageIndex >=
        MAX_PAGES
      ) {
        stopReason =
          `单批达到最大 ${MAX_PAGES} 页，已保存 Resume page=${nextParams.page}`;

        console.log(
          `[SuperLike][Resume] ${stopReason}；下一轮从该页继续。`
        );

        break;
      }


      const nextUrl =
        buildChaohuaUrl(
          sortTimeFlowId,
          nextParams,
          sortTimeRequestTemplateUrl
        );


      console.log(
        `[SuperLike] 直接请求下一页 sort_time：page=${nextParams.page}`
      );


      let nextResult =
        await fetchChaohuaInPage(
          page,
          nextUrl,
          sortTimeRequestTemplateHeaders
        );


      /*
       * 页面内 fetch 连续3次都没有拿到 HTTP Response 时，
       * 不立即结束整段扫描。
       *
       * 常见原因是代理瞬时抖动 / fetch Abort / 临时网络失败。
       * 先额外等待5秒，再做最后一次慢重试。
       */
      if (
        !nextResult.ok
        &&
        nextResult.httpStatus === null
      ) {
        console.log(
          `[SuperLike][sort_time慢重试] page=${nextParams.page} | 前3次均未拿到HTTP Response | error=${nextResult.error || '-'} | 5000ms后最后重试一次`
        );

        await page.waitForTimeout(
          5000
        );

        nextResult =
          await fetchChaohuaInPage(
            page,
            nextUrl,
            sortTimeRequestTemplateHeaders
          );
      }


      if (
        nextResult.httpStatus === 418
      ) {
        throw new Weibo418Error(
          'sort_time 下一页返回 HTTP 418'
        );
      }


      if (
        !nextResult.ok
      ) {
        stopReason =
          nextResult.httpStatus === null
            ? `sort_time 下一页请求失败：${nextResult.error || 'unknown error'}`
            : `sort_time 下一页 HTTP ${nextResult.httpStatus}`;

        console.log(
          `[SuperLike] ${stopReason}`
        );

        console.log(
          `[SuperLike][sort_time诊断] error=${nextResult.error || '-'}`
        );

        console.log(
          `[SuperLike][sort_time诊断] attempt=${nextResult.attempt || '-'} elapsed=${nextResult.elapsedMs || '-'}ms`
        );

        console.log(
          `[SuperLike][sort_time诊断] 模板URL=${sortTimeRequestTemplateUrl}`
        );

        console.log(
          `[SuperLike][sort_time诊断] 下一页URL=${nextUrl}`
        );

        console.log(
          `[SuperLike][sort_time诊断] Response=${nextResult.text || '-'}`
        );

        console.log(
          `[SuperLike][sort_time诊断] 模板Header=${Object.keys(
            sortTimeRequestTemplateHeaders
            ||
            {}
          ).join(',')}`
        );

        break;
      }


      current = {
        url:
          nextUrl,

        page:
          nextParams.page,

        json:
          nextResult.json
      };

      logicalPageNumber =
        Number(nextParams.page);


      if (
        PAGE_DELAY_MS > 0
      ) {
        await page.waitForTimeout(
          PAGE_DELAY_MS
        );
      }
    }


    /*
     * 如果 sort_time 因 checkpoint / 无下一页等原因提前结束，
     * 仍保证最新评论在本轮至少扫描一次。
     */
    freshSourceDone['latest-posts'] =
      true;

    await processFreshPoolSlice(
      'latest-posts-done'
    );

    await flushFreshPool(
      'latest-posts-finished'
    );


  } catch (error) {
    stopReason =
      `异常：${error.message}`;

    if (
      isProxyConnectionError(error)
      &&
      proxyAssignment?.raw
      &&
      !forceLocal
    ) {
      SCAN_PROXY_POOL.remove(
        proxyAssignment.raw
      );

      console.log(
        `[SuperLike] 代理连接失败：${proxyAssignment.masked}`
      );

      if (browser) {
        try {
          await browser.close();
        } catch {
          // ignore
        }

        browser = null;
      }

      const nextFailureCount =
        proxyFailureCount + 1;

      delegatedToLocal =
        true;

      console.log(
        `[SuperLike] 健康代理连接失败累计=${nextFailureCount}，继续从健康代理池获取下一个代理重试当前Monitor。`
      );

      return await scanOneSuperLikeMonitor(
        monitor,
        deleteUidSet,
        false,
        nextFailureCount,
        local418FallbackError
      );
    }

    if (
      isWeibo418Error(error)
      &&
      !proxyAssignment?.raw
    ) {
      console.log(
        '[SuperLike] 本地IP命中418，立即重新检查健康代理池。'
      );

      if (browser) {
        try {
          await browser.close();
        } catch {
          // ignore
        }

        browser = null;
      }

      const next =
        await acquireScanProxyWaiting();

      if (next?.proxy) {
        delegatedToLocal = true;

        console.log(
          `[SuperLike] 本地IP 418 → 切换健康代理：${next.masked}，重试当前Monitor。`
        );

        return await scanOneSuperLikeMonitor(
          monitor,
          deleteUidSet,
          false,
          proxyFailureCount,
          error
        );
      }

      console.log(
        '[SuperLike] 本地IP 418，但健康代理池确实为空；本轮无法切换代理。'
      );

      throw error;
    }

    if (
      isWeibo418Error(error)
      &&
      proxyAssignment?.raw
      &&
      !forceLocal
    ) {
      SCAN_PROXY_POOL.markBlocked(
        proxyAssignment.raw
      );

      const nextFailureCount =
        proxyFailureCount + 1;

      console.log(
        `[SuperLike] 当前代理命中418，已进入冷却：${proxyAssignment.masked}（累计失败=${nextFailureCount}）`
      );

      if (browser) {
        try {
          await browser.close();
        } catch {
          // ignore
        }

        browser = null;
      }

      delegatedToLocal =
        true;

      console.log(
        `[SuperLike] 代理418/失败累计=${nextFailureCount}，继续从健康代理池获取下一个代理重试当前Monitor。`
      );

      return await scanOneSuperLikeMonitor(
        monitor,
        deleteUidSet,
        false,
        nextFailureCount,
        local418FallbackError || error
      );
    }

    throw error;

  } finally {
    if (scanVisitorContext) {
      try {
        await scanVisitorContext.close();
      } catch {
        // ignore
      }

      scanVisitorContext = null;
    }

    if (browser) {
      try {
        await browser.close();

      } catch {
        // ignore
      }
    }


    /*
     * checkpoint 只在“本轮边界完整且安全”时推进。
     *
     * 特别注意：
     * 如果第N+1页418/失败，本轮前N页的数据仍然保留，
     * 但 checkpoint 不动；下一轮会从最新位置重新扫，
     * 直到重新追到旧 checkpoint，确保中间区间不会漏掉。
     */
    if (
      checkpointSafeToAdvance
      &&
      newestThisRound
    ) {
      try {
        saveScanCheckpoint(
          monitor.id,
          newestThisRound.postId,
          newestThisRound.createdAt,
          newestThisRound.createdAtMs
        );

        console.log(
          `[SuperLike][Checkpoint更新] ${newestThisRound.createdAt || '-'} / ${newestThisRound.postId}`
        );

      } catch (error) {
        console.error(
          '[SuperLike][Checkpoint更新失败]',
          error
        );
      }
    } else if (
      newestThisRound
      &&
      !checkpointSafeToAdvance
    ) {
      console.log(
        `[SuperLike][Checkpoint保留] 本轮未完整扫到安全边界，继续保留旧Checkpoint：${checkpoint?.latest_created_at || '-'} / ${checkpoint?.latest_post_id || '-'}`
      );
    }


    if (
      !delegatedToLocal
    ) {
      const seconds =
        Math.round(
          (
            Date.now()
            -
            startedAt
          )
          /
          1000
        );


      console.log('');
      console.log(
        `========== ${monitor.name} 本轮结果 ==========`
      );

    console.log(
      '扫描页数：',
      pagesScanned
    );

    console.log(
      'Post：',
      total.found
    );

    console.log(
      'Response内重复：',
      total.duplicateInRun
    );

    console.log(
      'DB已有：',
      total.existingInDb
    );

    console.log(
      '评论数未知：',
      total.unknownComments
    );

    console.log(
      '评论>=21：',
      total.commentsFull
    );

    console.log(
      '已有SuperLike：',
      total.hasSuperLike
    );

    console.log(
      '本Monitor新增待删UID：',
      total.deleteQueued
    );

    console.log(
      '符合候选：',
      total.target
    );

    console.log(
      '同UID本轮重复：',
      total.duplicateUidInRun
    );

    console.log(
      '新增UID：',
      total.inserted
    );

    console.log(
      '更新UID最新帖：',
      total.replaced
    );

    console.log(
      '停止原因：',
      stopReason
    );

    console.log(
      '耗时：',
      `${seconds}秒`
    );

      console.log(
        '=============================================='
      );
    }
  }
}



module.exports = {
  getScanMaxPages,
  saveScanResponseJson,
  parseTopicHomepage,
  scanOneSuperLikeMonitor,
  SCAN_PROFILE_CACHE_MINUTES
};
