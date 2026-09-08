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
  ProxyPool
} = require('./proxy-pool');
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
 * 8. Fresh按“最新发帖10页 + 三个专区各10页”分批即时处理，Profile/经验值默认2并发
 * 9. 历史 Resume 不阻塞 fresh；单轮历史预算默认5分钟
 * 10. UID不在 superlike_users + feed/Profile无chao_like + jyz<=80 + 评论<21 才入库
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

/*
 * Worker 模式：
 * - 默认 legacy：保持单进程旧行为，便于回滚。
 * - fresh：由 SUPERLIKE_SCAN_WORKER_SOURCE 指定唯一 Fresh 来源。
 * - history：只补 Resume，不参与 Fresh。
 */
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

const WEIBO_LOGIN_STATE_FILE =
  process.env.WEIBO_LOGIN_STATE_FILE
    ? path.resolve(
        process.env.WEIBO_LOGIN_STATE_FILE
      )
    : path.join(
        __dirname,
        '..',
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

const MAX_COMMENTS = 21;

const SCAN_PROFILE_CACHE_MINUTES =
  Number(
    process.env.SUPERLIKE_SCAN_PROFILE_CACHE_MINUTES
  )
  || 15;

let running = false;

const SCAN_PROXY_POOL =
  new ProxyPool({
    /*
     * Scan 优先使用我们自己维护、已经通过微博实测的健康代理池。
     * 不再直接从 SCDN 临时拉原始候选。
     */
    filePath:
      process.env.WEIBO_GOOD_PROXY_FILE
      || path.join(
        __dirname,
        '..',
        'data',
        'weibo-good-proxies.txt'
      ),

    dynamicSource:
      '',

    rawPool:
      process.env.SUPERLIKE_SCAN_PROXY_POOL
      || '',

    fallback:
      process.env.SUPERLIKE_SCAN_PROXY
      || process.env.WEIBO_PROXY
      || '',

    cooldownMs:
      Number(
        process.env.SUPERLIKE_PROXY_COOLDOWN_MS
      )
      || 30 * 60 * 1000,

    name:
      'scan'
  });


async function acquireScanProxyWaiting() {
  while (true) {
    const assignment =
      await SCAN_PROXY_POOL.acquire();

    if (
      assignment?.proxy
      &&
      !assignment.allCoolingDown
    ) {
      return assignment;
    }

    /*
     * 和 Mode2 一样：
     * 有代理，只是全部处于418冷却时，不切本地，等待最近一个恢复。
     */
    if (
      assignment?.allCoolingDown
      &&
      Number.isFinite(
        Number(assignment.nextReadyAt)
      )
    ) {
      const waitMs =
        Math.max(
          1000,
          Number(assignment.nextReadyAt)
            - Date.now()
        );

      console.log(
        `[SuperLike] 健康代理全部冷却，等待最近代理恢复：约${Math.ceil(waitMs / 1000)}秒。`
      );

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            waitMs
          )
      );

      continue;
    }

    /*
     * 健康代理池真的为空时，才允许本地兜底。
     */
    return {
      configured: false,
      raw: null,
      proxy: null,
      masked: 'LOCAL'
    };
  }
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
        __dirname,
        '..',
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

function initSuperLikeTable() {
  initDatabase();
}

function deletePostsByUidWithLog(
  uid,
  reason
) {
  const normalizedUid =
    String(uid || '').trim();

  if (!normalizedUid) {
    return 0;
  }

  const deleted =
    deletePostsByUidSet(
      new Set([normalizedUid])
    );

  const superLikeReason =
    String(reason || '')
      .toUpperCase()
      .startsWith('SUPERLIKE_')
    ||
    String(reason || '')
      .toUpperCase()
      === 'FEED_SUPERLIKE_ICON';

  if (
    superLikeReason
    &&
    deleted > 0
  ) {
    addSuperLikePoolExitCount(1);
  }

  // 没有实际删除候选帖时不打印日志，避免 FEED_SUPERLIKE_ICON 大量刷屏。
  if (deleted > 0) {
    console.log(
      `[DB删除][UID=${normalizedUid}] 原因=${reason || 'UNSPECIFIED'} | 删除=${deleted} | 今日毕业+${superLikeReason ? 1 : 0}`
    );
  }

  return deleted;
}


// 保留 scanner 内原函数名，实际数据库查询统一交给 db.js。
function postIdExists(postId) {
  return superLikePostIdExists(postId);
}


function parsePostCreatedAtMs(post) {
  const raw =
    getPostCreatedAt(post);

  if (!raw) {
    return null;
  }

  const ms =
    Date.parse(raw);

  return Number.isFinite(ms)
    ? ms
    : null;
}


function getNewestPostInfo(posts) {
  let best = null;

  for (
    const post
    of posts
  ) {
    const postId =
      getPostId(post);

    const createdAt =
      getPostCreatedAt(post);

    const createdAtMs =
      parsePostCreatedAtMs(post);

    if (
      !postId
      ||
      !Number.isFinite(
        Number(createdAtMs)
      )
    ) {
      continue;
    }

    if (
      !best
      ||
      createdAtMs >
        best.createdAtMs
    ) {
      best = {
        postId,
        createdAt,
        createdAtMs
      };
    }
  }

  return best;
}


function shouldStopAtCheckpoint(
  post,
  checkpoint
) {
  if (
    !checkpoint
    ||
    !checkpoint.latest_post_id
  ) {
    return false;
  }

  const postId =
    getPostId(post);

  if (!postId) {
    return false;
  }

  /*
   * 只按上一轮真实 post_id 判断 checkpoint。
   * 不再因为 created_at 比 checkpoint 时间早就停止，
   * 避免微博同一页/相邻页并非严格按发帖时间排序时漏帖。
   */
  return (
    String(postId) ===
    String(checkpoint.latest_post_id)
  );
}



class Weibo418Error extends Error {
  constructor(message = '微博 HTTP 418') {
    super(message);
    this.name = 'Weibo418Error';
    this.isWeibo418 = true;
  }
}

function isWeibo418Error(error) {
  return !!(
    error
    && (
      error.isWeibo418
      || error.name === 'Weibo418Error'
      || String(error.message || '').includes('HTTP 418')
    )
  );
}

function isProxyConnectionError(error) {
  const text =
    String(
      error?.message
      || error
      || ''
    );

  return (
    /ERR_TUNNEL_CONNECTION_FAILED/i.test(text)
    ||
    /ERR_PROXY_CONNECTION_FAILED/i.test(text)
    ||
    /ERR_SOCKS_CONNECTION_FAILED/i.test(text)
    ||
    /ERR_CONNECTION_RESET/i.test(text)
    ||
    /ERR_CONNECTION_CLOSED/i.test(text)
    ||
    /ERR_CONNECTION_REFUSED/i.test(text)
    ||
    /ERR_TIMED_OUT/i.test(text)
    ||
    /Timeout \d+ms exceeded/i.test(text)
    ||
    /Navigation timeout/i.test(text)
    ||
    /Failed to fetch/i.test(text)
    ||
    /PROXY_PAGE_INVALID/i.test(text)
    ||
    /407\b/i.test(text)
    ||
    /402\b/i.test(text)
    ||
    /proxy.*authentication/i.test(text)
    ||
    /proxy.*connection/i.test(text)
  );
}

async function assertPageNot418(page, response = null) {
  if (response && response.status && response.status() === 418) {
    throw new Weibo418Error('微博首页返回 HTTP 418');
  }

  const title = await page.title().catch(() => '');
  const bodyText = await page.locator('body').innerText().catch(() => '');

  if (
    title.includes('418')
    || bodyText.includes('HTTP ERROR 418')
    || bodyText.includes('HTTP 418')
  ) {
    throw new Weibo418Error('微博页面检测到 HTTP 418');
  }
}


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

function stripHtml(value) {
  if (value == null) {
    return '';
  }

  return String(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim();
}

function getPostId(post) {
  const value =
    post?.idstr
    ?? post?.mid
    ?? post?.id;

  return (
    value === null ||
    value === undefined ||
    value === ''
  )
    ? ''
    : String(value);
}

function getUid(post) {
  const value =
    post?.user?.idstr
    ?? post?.user?.id
    ?? post?.uid;

  return (
    value === null ||
    value === undefined ||
    value === ''
  )
    ? ''
    : String(value);
}

function getUsername(post) {
  return (
    post?.user?.screen_name
    ?? post?.user?.name
    ?? null
  );
}

function getPostText(post) {
  return stripHtml(
    post?.text
    ?? post?.raw_text
    ?? post?.text_raw
    ?? ''
  );
}

function getCommentsCount(post) {
  const value =
    post?.comments_count
    ?? post?.comment_count;

  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function getPostCreatedAt(post) {
  const value =
    post?.created_at
    ?? post?.createdAt
    ?? null;

  return value
    ? String(value)
    : null;
}

function getPostLink(post) {
  const uid =
    getUid(post);

  const postId =
    getPostId(post);

  if (
    !uid ||
    !postId
  ) {
    return '';
  }

  return `https://weibo.com/${uid}/${postId}`;
}



/* ============================================================
 * Find Posts
 * ============================================================ */

function looksLikePost(obj) {
  if (
    !obj
    ||
    typeof obj !== 'object'
    ||
    Array.isArray(obj)
  ) {
    return false;
  }

  const postId =
    obj.idstr
    ?? obj.mid
    ?? obj.id;

  if (
    !postId
    ||
    !obj.user
  ) {
    return false;
  }

  return (
    obj.comments_count !== undefined
    ||
    obj.comment_count !== undefined
    ||
    obj.text !== undefined
    ||
    obj.raw_text !== undefined
    ||
    obj.text_raw !== undefined
    ||
    obj.reposts_count !== undefined
    ||
    obj.attitudes_count !== undefined
  );
}

function findPosts(
  value,
  result = [],
  visited = new Set()
) {
  if (
    !value
    ||
    typeof value !== 'object'
    ||
    visited.has(value)
  ) {
    return result;
  }

  visited.add(value);

  if (looksLikePost(value)) {
    result.push(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      findPosts(
        item,
        result,
        visited
      );
    }

    return result;
  }

  for (
    const child
    of Object.values(value)
  ) {
    if (
      child
      &&
      typeof child === 'object'
    ) {
      findPosts(
        child,
        result,
        visited
      );
    }
  }

  return result;
}


/* ============================================================
 * SuperLike / icons
 * ============================================================ */

function hasSuperLike(post) {
  /*
   * 真实 Response 已确认：
   *
   * user.icons = [
   *   {
   *     name: "chao_like"
   *   }
   * ]
   *
   * 所以优先做精确判断。
   */
  const icons =
    Array.isArray(
      post?.user?.icons
    )
      ? post.user.icons
      : [];

  if (
    icons.some(
      icon =>
        String(
          icon?.name || ''
        ).toLowerCase()
        === 'chao_like'
    )
  ) {
    return true;
  }

  /*
   * 兼容未来字段变化。
   */
  let text = '';

  try {
    text =
      JSON.stringify(
        post?.user || {}
      ).toLowerCase();

  } catch {
    return false;
  }

  return (
    text.includes('"name":"chao_like"')
    ||
    text.includes('"name":"chaolike"')
    ||
    text.includes('"name":"super_like"')
    ||
    text.includes('"name":"superlike"')
  );
}

function extractIcons(post) {
  const icons =
    Array.isArray(
      post?.user?.icons
    )
      ? post.user.icons
      : [];

  return icons
    .map(
      icon =>
        String(
          icon?.name || ''
        ).trim()
    )
    .filter(Boolean)
    .filter(
      name =>
        name.toLowerCase()
        !== 'chao_like'
    );
}


/* ============================================================
 * Save
 * ============================================================ */

function saveTargetPost(
  monitorId,
  post,
  profileStatus = 'UNKNOWN',
  experience7d = null
) {
  const postId =
    getPostId(post);

  if (!postId) {
    return {
      status: 'skip',
      reason: 'no_post_id'
    };
  }

  const uid =
    getUid(post);

  if (!uid) {
    return {
      status: 'skip',
      reason: 'no_uid'
    };
  }

  /*
   * 三级判断 STEP 1：
   * UID 已经在 superlike_users 中 -> 直接忽略。
   * 这是纯本地 DB 查询，不产生额外微博请求。
   */
  const knownSuperLike =
    isSuperLikeUser(
      uid
    );

  if (knownSuperLike) {
    return {
      status: 'skip',
      reason: 'uid_in_superlike_users'
    };
  }

  /*
   * 三级判断 STEP 2：
   * 当前 feed Response 已明确带 chao_like。
   * 立即保存到 superlike_users，并立即清掉该 UID 已有候选。
   */
  if (
    hasSuperLike(post)
  ) {
    saveSuperLikeUser(
      monitorId,
      uid
    );

    deletePostsByUidWithLog(
      uid,
      'FEED_SUPERLIKE_ICON'
    );

    return {
      status: 'skip',
      reason: 'has_superlike'
    };
  }

  /*
   * 三级判断 STEP 3：
   * 评论 >= 21 不入库；0-20 才作为候选。
   */
  const commentsCount =
    getCommentsCount(post);

  if (
    commentsCount === null
  ) {
    return {
      status: 'skip',
      reason: 'unknown_comments'
    };
  }

  if (
    commentsCount >= MAX_COMMENTS
  ) {
    return {
      status: 'skip',
      reason: 'comments_full'
    };
  }

  const username =
    getUsername(post);

  const postLink =
    getPostLink(post);

  const postText =
    getPostText(post);

  const postCreatedAt =
    getPostCreatedAt(post);

  const postCreatedAtMs =
    parsePostCreatedAtMs(post);

  const icons =
    extractIcons(post);

  const iconSummary =
    icons.length > 0
      ? icons.join(' / ')
      : '无';

  let rawJson = null;

  try {
    rawJson =
      JSON.stringify(post);

  } catch {
    rawJson = null;
  }

  return saveSuperLikeTargetPost({
    monitorId,
    postId,
    uid,
    username,
    postLink,
    postText,
    commentsCount,
    iconSummary,
    postCreatedAt,
    postCreatedAtMs,
    profileStatus,
    experience7d,
    rawJson
  });
}



/* ============================================================
 * AJAX helpers
 * ============================================================ */

function parseChaohuaRequestUrl(
  requestUrl
) {
  try {
    const url =
      new URL(requestUrl);

    if (
      url.hostname !== 'weibo.com'
      ||
      url.pathname !==
        '/ajax_proxy/chaohua/page'
    ) {
      return null;
    }

    return {
      flowId:
        url.searchParams.get(
          'flowId'
        ),

      page:
        Number(
          url.searchParams.get(
            'page'
          )
          || 1
        ),

      url:
        requestUrl
    };

  } catch {
    return null;
  }
}


/**
 * ============================================================
 * 捕获指定 flowId 的下一条 Response
 * ============================================================
 */

function waitForChaohuaResponse(
  page,
  targetFlowId,
  timeoutMs = FEED_WAIT_MS
) {
  return new Promise(resolve => {
    let done = false;

    const timer =
      setTimeout(
        () => {
          if (done) {
            return;
          }

          done = true;

          page.off(
            'response',
            onResponse
          );

          resolve(null);
        },

        timeoutMs
      );


    async function onResponse(
      response
    ) {
      if (done) {
        return;
      }

      const info =
        parseChaohuaRequestUrl(
          response.url()
        );

      if (
        !info
        ||
        info.flowId !==
          targetFlowId
      ) {
        return;
      }

      console.log(
        `[SuperLike][AJAX] status=${response.status()} flowId=${info.flowId} page=${info.page}`
      );

      if (response.status() === 418) {
        done = true;
        clearTimeout(timer);
        page.off('response', onResponse);
        resolve({
          http418: true,
          url: response.url(),
          page: info.page
        });
        return;
      }

      let json;

      try {
        json =
          await response.json();

      } catch {
        return;
      }


      if (
        response.status() < 200
        ||
        response.status() >= 300
      ) {
        return;
      }


      done = true;

      clearTimeout(
        timer
      );

      page.off(
        'response',
        onResponse
      );


      resolve({
        url:
          response.url(),

        page:
          info.page,

        json,

        requestHeaders:
          response.request().headers()
      });
    }


    page.on(
      'response',
      onResponse
    );
  });
}


/**
 * ============================================================
 * 点击一级“最新”
 * ============================================================
 */
async function clickPrimaryLatest(
  page
) {
  console.log(
    '[SuperLike] 等待一级“最新”Tab渲染...'
  );

  const timeoutMs = 15000;
  const startedAt = Date.now();

  while (
    Date.now() - startedAt < timeoutMs
  ) {

    /*
     * 只负责找到真正的“最新”文字节点。
     *
     * 不在 page.evaluate() 里面 click，
     * 而是返回 locator 后让 Playwright 真正点击。
     */
    const latest =
      page.locator(
        '.wbpro-textcut'
      )
      .filter({
        hasText: /^最新$/
      });


    const count =
      await latest.count();


    if (
      count > 0
    ) {

      for (
        let i = 0;
        i < count;
        i++
      ) {

        const textNode =
          latest.nth(i);


        if (
          !await textNode.isVisible()
        ) {
          continue;
        }


        /*
         * DOM：
         *
         * woo-box-item-inlineBlock
         *   └─ ...
         *       └─ wbpro-textcut "最新"
         *
         * 所以必须向上找到
         * woo-box-item-inlineBlock
         *
         * 不能点击 wbpro-tab2 总容器。
         */
        const tab =
          textNode.locator(
            'xpath=ancestor::div[contains(@class,"woo-box-item-inlineBlock")][1]'
          );


        if (
          await tab.count()
          ===
          0
        ) {
          continue;
        }


        if (
          !await tab.isVisible()
        ) {
          continue;
        }


        const html =
          await tab.evaluate(
            element =>
              element.outerHTML
          );


        console.log(
          `[SuperLike] 找到一级“最新”Tab：${html.slice(
            0,
            500
          )}`
        );


        /*
         * Playwright真实点击。
         */
        await tab.click({
          force: true
        });


        console.log(
          '[SuperLike] 已点击一级“最新”'
        );


        return true;
      }
    }


    /*
     * 第二层 DOM fallback：
     * 微博有时会改 .wbpro-textcut class，但文字“最新”仍在。
     * 这里不依赖具体 class，只找可见且文本精确为“最新”的节点，
     * 再向上找常见可点击父级。
     */
    const genericLatest =
      page.getByText(
        '最新',
        {
          exact: true
        }
      );

    const genericCount =
      await genericLatest.count();

    for (
      let i = 0;
      i < genericCount;
      i++
    ) {
      const node =
        genericLatest.nth(i);

      if (
        !await node.isVisible()
      ) {
        continue;
      }

      const clickable =
        node.locator(
          'xpath=ancestor::*[self::button or @role="tab" or contains(@class,"woo-box-item-inlineBlock")][1]'
        );

      if (
        await clickable.count()
        > 0
        &&
        await clickable.isVisible()
      ) {
        console.log(
          '[SuperLike] 通过通用文字定位找到一级“最新”Tab'
        );

        await clickable.click({
          force: true
        });

        console.log(
          '[SuperLike] 已点击一级“最新”（通用fallback）'
        );

        return true;
      }
    }


    await page.waitForTimeout(
      500
    );
  }


  console.error(
    '[SuperLike] 15秒内仍未找到一级“最新”Tab'
  );


  return false;
}
/**
 * ============================================================
 * 从 _feed Response 找“最新发帖” containerid
 * ============================================================
 */

function extractLatestPostFlowId(
  feedJson
) {
  const items =
    Array.isArray(
      feedJson?.items
    )
      ? feedJson.items
      : [];


  for (
    const item
    of items
  ) {
    /*
     * 你给的 Response 中：
     *
     * item.category = "card"
     * item.data.itemid = "page_feed_child_tab"
     */
    const itemId =
      item?.itemid
      ??
      item?.data?.itemid;


    if (
      itemId !==
      'page_feed_child_tab'
    ) {
      continue;
    }


    const groups =
      item?.filter_group
      ??
      item?.data?.filter_group;


    if (
      !Array.isArray(groups)
    ) {
      continue;
    }


    const target =
      groups.find(
        group =>
          String(
            group?.name || ''
          ).trim()
          === '最新发帖'
      );


    if (
      target?.containerid
    ) {
      return String(
        target.containerid
      );
    }
  }


  return null;
}


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

function extractNextPageParams(
  json
) {
  const candidates = [
    json?.moreInfo?.params,
    json?.data?.moreInfo?.params,
    json?.data?.more_info?.params,
    json?.more_info?.params
  ];


  for (
    const params
    of candidates
  ) {
    if (
      params
      &&
      typeof params === 'object'
      &&
      Number(params.page) >= 2
    ) {
      return {
        page:
          Number(params.page),

        since_id:
          params.since_id
          !== undefined
          &&
          params.since_id
          !== null
            ? String(
                params.since_id
              )
            : null,

        max_id:
          params.max_id
          !== undefined
          &&
          params.max_id
          !== null
            ? String(
                params.max_id
              )
            : '0'
      };
    }
  }


  return null;
}


/*
 * tag_status_sort 分区分页和 sort_time 略有不同：
 * 第二页真实请求可能没有 page=2，而只靠 since_id/max_id。
 * 所以这里不要求 params.page >= 2。
 */
function extractTagNextPageParams(
  json
) {
  const candidates = [
    json?.moreInfo?.params,
    json?.data?.moreInfo?.params,
    json?.data?.more_info?.params,
    json?.more_info?.params
  ];

  for (
    const params
    of candidates
  ) {
    if (
      !params
      ||
      typeof params !== 'object'
    ) {
      continue;
    }

    const sinceId =
      params.since_id
      !== undefined
      &&
      params.since_id !== null
        ? String(params.since_id)
        : null;

    if (!sinceId) {
      continue;
    }

    return {
      page:
        params.page !== null
        &&
        params.page !== undefined
        &&
        params.page !== ''
        &&
        Number.isFinite(
          Number(params.page)
        )
          ? Number(params.page)
          : null,

      since_id:
        sinceId,

      max_id:
        params.max_id
        !== undefined
        &&
        params.max_id !== null
          ? String(params.max_id)
          : '0',

      count:
        params.count
        !== undefined
        &&
        params.count !== null
          ? String(params.count)
          : '15',

      page_common_ext:
        params.page_common_ext
        !== undefined
        &&
        params.page_common_ext !== null
          ? String(params.page_common_ext)
          : 'topicPrompt:1|page:tag_status_sort=1|hide_page:1'
    };
  }

  return null;
}


function buildTagSectionUrl(
  flowId,
  pageParams = null
) {
  const url =
    new URL(
      '/ajax_proxy/chaohua/page',
      'https://weibo.com'
    );

  url.searchParams.set(
    'flowId',
    flowId
  );

  if (!pageParams) {
    return url.toString();
  }

  if (
    pageParams.page !== null
    &&
    pageParams.page !== undefined
    &&
    pageParams.page !== ''
    &&
    Number.isFinite(
      Number(pageParams.page)
    )
  ) {
    url.searchParams.set(
      'page',
      String(pageParams.page)
    );
  }

  if (pageParams.since_id) {
    url.searchParams.set(
      'since_id',
      pageParams.since_id
    );
  }

  url.searchParams.set(
    'count',
    pageParams.count
    || '15'
  );

  url.searchParams.set(
    'max_id',
    pageParams.max_id
    ?? '0'
  );

  url.searchParams.set(
    'page_common_ext',
    pageParams.page_common_ext
    || 'topicPrompt:1|page:tag_status_sort=1|hide_page:1'
  );

  return url.toString();
}


function buildChaohuaUrl(
  flowId,
  pageParams = null,
  templateUrl = null
) {
  /*
   * 后续分页优先复制微博前端真实发出的 sort_time URL，
   * 保留它原本的所有 query 参数。
   *
   * 只替换分页相关参数，避免自己从零拼 URL 导致 403。
   */
  const url =
    templateUrl
      ? new URL(templateUrl)
      : new URL(
          '/ajax_proxy/chaohua/page',
          'https://weibo.com'
        );


  url.searchParams.set(
    'flowId',
    flowId
  );


  if (!pageParams) {
    return url.toString();
  }


  url.searchParams.set(
    'page',
    String(
      pageParams.page
    )
  );


  if (
    pageParams.since_id
  ) {
    url.searchParams.set(
      'since_id',
      pageParams.since_id
    );
  } else {
    url.searchParams.delete(
      'since_id'
    );
  }


  url.searchParams.set(
    'max_id',
    pageParams.max_id
    ?? '0'
  );


  return url.toString();
}


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

async function fetchJsonInPageWithRetry(
  page,
  url,
  {
    headers = {
      Accept:
        'application/json, text/plain, */*'
    },
    maxAttempts = 3,
    retryDelaysMs = [500, 1000],
    timeoutMs = 30000
  } = {}
) {
  let lastResult = null;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {
    const startedAt =
      Date.now();

    const result =
      await page.evaluate(
        async ({
          requestUrl,
          requestHeaders,
          requestTimeoutMs
        }) => {
          const controller =
            new AbortController();

          const timer =
            setTimeout(
              () =>
                controller.abort(),
              Math.max(
                1000,
                Number(
                  requestTimeoutMs
                  || 8000
                )
              )
            );

          try {
            const response =
              await fetch(
                requestUrl,
                {
                  method:
                    'GET',

                  credentials:
                    'include',

                  headers:
                    requestHeaders,

                  signal:
                    controller.signal
                }
              );

            const text =
              await response.text();

            let json = null;

            try {
              json =
                JSON.parse(
                  text
                );
            } catch {
              // 非 JSON 保留原始文本，由调用方判断。
            }

            clearTimeout(
              timer
            );

            return {
              httpStatus:
                response.status,

              ok:
                response.ok,

              finalUrl:
                response.url,

              text,

              json,

              error:
                null
            };

          } catch (error) {
            clearTimeout(
              timer
            );

            return {
              httpStatus:
                null,

              ok:
                false,

              finalUrl:
                requestUrl,

              text:
                '',

              json:
                null,

              error:
                error?.message
                || String(error)
            };
          }
        },

        {
          requestUrl:
            url,

          requestHeaders:
            headers,

          requestTimeoutMs:
            timeoutMs
        }
      );

    result.attempt =
      attempt;

    result.elapsedMs =
      Date.now()
      - startedAt;

    lastResult =
      result;

    const status =
      Number(
        result.httpStatus
      );

    const retryable =
      (
        result.httpStatus === null
        ||
        result.error
        ||
        status === 429
        ||
        status >= 500
      );

    /*
     * 418 不在这里盲目重试：
     * 交给上层现有的 418 / 代理切换逻辑处理。
     */
    if (
      result.ok
      ||
      status === 418
      ||
      !retryable
      ||
      attempt >= maxAttempts
    ) {
      return result;
    }

    const delayMs =
      retryDelaysMs[
        Math.min(
          attempt - 1,
          retryDelaysMs.length - 1
        )
      ]
      ?? 1000;

    console.log(
      `[SuperLike][Fetch重试] ${attempt}/${maxAttempts} 失败 | status=${result.httpStatus ?? '-'} | error=${result.error || '-'} | ${result.elapsedMs}ms | ${delayMs}ms后重试`
    );

    await page.waitForTimeout(
      delayMs
    );
  }

  return lastResult;
}


async function fetchChaohuaInPage(
  page,
  url,
  requestHeaders = null
) {
  /*
   * 浏览器 fetch 不能手工设置 Cookie / Referer / User-Agent 等受限头。
   * 这些由当前 weibo.com 页面上下文自动携带。
   *
   * 这里只复用第一页真实请求里的安全自定义 header，
   * 特别是微博可能依赖的 x-* / client-* 等字段。
   */
  const safeHeaders = {
    Accept:
      'application/json, text/plain, */*'
  };


  if (
    requestHeaders
    &&
    typeof requestHeaders === 'object'
  ) {
    for (
      const [
        rawName,
        rawValue
      ]
      of Object.entries(
        requestHeaders
      )
    ) {
      const name =
        String(
          rawName
          ||
          ''
        ).toLowerCase();

      if (
        !rawValue
      ) {
        continue;
      }

      if (
        name.startsWith('x-')
        ||
        name.startsWith('client-')
      ) {
        safeHeaders[
          rawName
        ] = String(
          rawValue
        );
      }
    }
  }


  const result =
    await fetchJsonInPageWithRetry(
      page,
      url,
      {
        headers:
          safeHeaders,
        maxAttempts:
          3,
        retryDelaysMs:
          [500, 1000]
      }
    );

  return {
    ...result,
    text:
      String(
        result?.text
        || ''
      ).slice(
        0,
        500
      )
  };
}



/**
 * ============================================================
 * 等待并点击二级“最新发帖”
 * ============================================================
 */
async function clickLatestPostTab(
  page
) {
  console.log(
    '[SuperLike] 等待二级“最新发帖”Tab渲染...'
  );

  const latestPost =
    page.getByText(
      '最新发帖',
      {
        exact: true
      }
    );

  await latestPost.first().waitFor({
    state: 'visible',
    timeout: 10000
  });

  const count =
    await latestPost.count();

  console.log(
    `[SuperLike] 找到 ${count} 个“最新发帖”候选`
  );

  for (
    let i = 0;
    i < count;
    i++
  ) {
    const item =
      latestPost.nth(i);

    if (
      !(await item.isVisible())
    ) {
      continue;
    }

    await item.scrollIntoViewIfNeeded();

    console.log(
      '[SuperLike] 点击二级“最新发帖”...'
    );

    await item.click({
      timeout: 5000
    });

    return true;
  }

  throw new Error(
    '“最新发帖”已出现但没有可点击元素'
  );
}


/**
 * ============================================================
 * 滚动页面，让微博前端自己触发下一页 AJAX
 * ============================================================
 */
async function triggerNextPage(
  page
) {
  await page.evaluate(
    () => {
      window.scrollTo(
        0,
        document.body.scrollHeight
      );

      const elements =
        Array.from(
          document.querySelectorAll('*')
        );

      let best = null;
      let bestAmount = 0;

      for (
        const el
        of elements
      ) {
        const style =
          window.getComputedStyle(el);

        if (
          ![
            'auto',
            'scroll'
          ].includes(
            style.overflowY
          )
        ) {
          continue;
        }

        const amount =
          el.scrollHeight
          - el.clientHeight;

        if (
          amount >
          bestAmount
        ) {
          bestAmount = amount;
          best = el;
        }
      }

      if (best) {
        best.scrollTop =
          best.scrollHeight;
      }
    }
  );

  await page.waitForTimeout(
    800
  );

  try {
    await page.mouse.wheel(
      0,
      4000
    );
  } catch {
    // ignore
  }
}



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
function buildProfileInPageApiUrl(
  config,
  uid
) {
  const url =
    new URL(
      'https://m.weibo.cn/api/container/getIndex'
    );

  url.searchParams.set(
    'containerid',
    config.profileContainerId
  );

  /*
   * 先人为保留一次 %23，
   * URLSearchParams 再编码一次，
   * 最终得到 target_uid%2523{uid}
   */
  url.searchParams.set(
    'extparam',
    `target_uid%23${uid}`
  );

  url.searchParams.set(
    'luicode',
    '10000011'
  );

  url.searchParams.set(
    'lfid',
    config.chaoLikeListContainerId
  );

  url.searchParams.set(
    'launchid',
    '10000360-page_H5'
  );

  return url.toString();
}


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
function profileHasSuperLike(
  profileData
) {
  let profileText;

  try {
    profileText =
      typeof profileData === 'string'
        ? profileData
        : JSON.stringify(profileData);
  } catch (error) {
    console.log(
      `[SuperLike][ProfileText转换失败] ${error.message}`
    );
    return false;
  }


  return (
    profileText.includes('fans_title_superlike.png') ||
    profileText.includes('fans_title_superlike_on.png') ||
    profileText.includes('superlike') 
  );
}

/*
 * 从 profile_inpage JSON 中提取“TA发布的”顶层帖子。
 *
 * 真实 Response 结构：
 * data.cards[].card_group[].mblog
 *
 * 这里故意只取顶层 mblog，不递归进入 retweeted_status，
 * 避免把转发原文当成该用户自己的超话帖子。
 */
function getProfilePosts(
  profileData,
  uid
) {
  const cards =
    Array.isArray(
      profileData?.data?.cards
    )
      ? profileData.data.cards
      : [];

  const posts = [];

  for (
    const card
    of cards
  ) {
    const groups =
      Array.isArray(
        card?.card_group
      )
        ? card.card_group
        : [];

    for (
      const item
      of groups
    ) {
      const post =
        item?.mblog;

      if (
        !post
        ||
        typeof post !== 'object'
      ) {
        continue;
      }

      const postUid =
        getUid(
          post
        );

      if (
        String(postUid || '')
        !==
        String(uid || '')
      ) {
        continue;
      }

      posts.push(
        post
      );
    }
  }

  return posts;
}

function pickProfileReplacementPost(profilePosts) {
  const oneMonthAgo =
    Date.now()
    - 30 * 24 * 60 * 60 * 1000;

  return profilePosts.find(
    post => {
      const comments =
        getCommentsCount(
          post
        );

      const createdAtMs =
        parsePostCreatedAtMs(
          post
        );

      return (
        comments !== null
        &&
        comments >= 1
        &&
        comments <= 4
        &&
        Number.isFinite(
          Number(createdAtMs)
        )
        &&
        Number(createdAtMs) >=
          oneMonthAgo
        &&
        Number(createdAtMs) <=
          Date.now()
      );
    }
  )
  || null;
}


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
const SCAN_EXPERIENCE_TIMEOUT_MS = 7000;

function extractExperience7d(currentInfo) {
  const text =
    String(currentInfo || '').trim();

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
    Number(match[1]);

  return Number.isFinite(value)
    ? value
    : null;
}

async function fetchSuperLikeExperience7d(
  context,
  config,
  uid
) {
  try {
    if (
      !context
      ||
      !context.request
      ||
      typeof context.request.get
        !== 'function'
    ) {
      return {
        ok: false,
        experience7d: null,
        message:
          '当前scanner persistent BrowserContext不支持request.get'
      };
    }

    const pageId =
      `100808${config.topicHash}`;

    const url =
      new URL(
        'https://huati.weibo.cn/aj/setting/icon/getconfig'
      );

    url.searchParams.set(
      'type',
      '1'
    );

    url.searchParams.set(
      'union_id',
      'chao_like'
    );

    url.searchParams.set(
      'page_id',
      pageId
    );

    url.searchParams.set(
      'param_uid',
      String(uid)
    );

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

    /*
     * JYZ 回到最初方案：
     * 直接使用当前 scanner 的 persistent BrowserContext.request。
     * 这样继承该 worker 自己的 Cookie / 登录态 / 代理环境。
     * Profile 校验仍继续使用独立游客 Context。
     */
    const response =
      await context.request.get(
        url.toString(),
        {
          timeout:
            SCAN_EXPERIENCE_TIMEOUT_MS,
          failOnStatusCode:
            false,
          headers: {
            'Accept':
              'application/json, text/plain, */*',
            'X-Requested-With':
              'XMLHttpRequest',
            'Referer':
              referer.toString(),
            'User-Agent':
              'Mozilla/5.0 (Linux; Android 14) '
              + 'AppleWebKit/537.36 (KHTML, like Gecko) '
              + 'Mobile Safari/537.36 _weibo_'
          }
        }
      );

    const status =
      response.status();

    const text =
      await response.text();

    if (
      status < 200
      ||
      status >= 300
    ) {
      return {
        ok: false,
        experience7d: null,
        status,
        message:
          `HTTP ${status}`
      };
    }

    if (
      text
        .trimStart()
        .startsWith('<')
    ) {
      return {
        ok: false,
        experience7d: null,
        status,
        message:
          '返回HTML/Access Deny'
      };
    }

    let json;

    try {
      json =
        JSON.parse(
          text
        );
    } catch (error) {
      return {
        ok: false,
        experience7d: null,
        status,
        message:
          `JSON解析失败：${error.message}`
      };
    }

    if (
      Number(
        json?.code
      ) !== 100000
    ) {
      return {
        ok: false,
        experience7d: null,
        status,
        message:
          `API code=${json?.code ?? '-'} msg=${json?.msg || '-'}`
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
        experience7d: null,
        status,
        currentInfo,
        message:
          'current_info没有可解析经验值'
      };
    }

    return {
      ok: true,
      experience7d,
      currentInfo,
      status,
      source:
        'scanner-persistent-context'
    };

  } catch (error) {
    return {
      ok: false,
      experience7d: null,
      status: null,
      message:
        error?.message
        || String(error)
    };
  }
}


async function checkUserSuperLikeByProfileInner(
  context,
  config,
  uid,
  reusableProfileContext = null
) {
  const apiUrl =
    buildProfileInPageApiUrl(
      config,
      uid
    );

  const pageUrl =
    new URL(
      'https://m.weibo.cn/p/index'
    );

  pageUrl.searchParams.set(
    'containerid',
    config.profileContainerId
  );

  pageUrl.searchParams.set(
    'extparam',
    `target_uid%23${uid}`
  );

  pageUrl.searchParams.set(
    'luicode',
    '10000011'
  );

  pageUrl.searchParams.set(
    'lfid',
    config.chaoLikeListContainerId
  );

  pageUrl.searchParams.set(
    'launchid',
    '10000360-page_H5'
  );

  console.log(
    `[SuperLike][ProfileURL] ${apiUrl}`
  );

  console.log(
    `[SuperLike][Profile页面] ${pageUrl.toString()}`
  );

  let profileContext =
    reusableProfileContext
    || null;

  const ownsProfileContext =
    !reusableProfileContext;

  let profilePage = null;

  try {
    /*
     * 真正模拟浏览器无痕访问：
     * - 新建匿名 BrowserContext，不继承登录 Cookie/localStorage
     * - 打开真实 /p/index 用户超话主页，而不是直接导航 API
     * - 监听页面自己发出的 profile_inpage XHR
     * - 一旦拿到目标 Response，就直接使用
     * - 拿到 Profile 后，阻止页面继续跳 passport / 登录页
     */
    if (!profileContext) {
      const parentBrowser =
        context.browser();

      if (
        !parentBrowser
        ||
        typeof parentBrowser.newContext
          !== 'function'
      ) {
        throw new Error(
          '无法创建游客 BrowserContext'
        );
      }

      profileContext =
        await parentBrowser.newContext({
          viewport: {
            width: 1280,
            height: 900
          }
        });
    }

    profilePage =
      await profileContext.newPage();

    let profileCaptured =
      false;

    await profilePage.route(
      '**/*',
      async route => {
        const request =
          route.request();

        const requestUrl =
          request.url();

        let host =
          '';

        try {
          host =
            new URL(
              requestUrl
            ).hostname
              .toLowerCase();
        } catch {
          host = '';
        }

        const isPassport =
          host ===
            'visitor.passport.weibo.cn'
          ||
          host ===
            'passport.weibo.cn'
          ||
          host ===
            'passport.weibo.com';

        /*
         * 只有在 Profile 数据已经拿到后，
         * 才拦截后续登录跳转。
         *
         * 在此之前不破坏微博正常的游客初始化流程。
         */
        if (
          isPassport
          &&
          profileCaptured
        ) {
          console.log(
            `[SuperLike][Profile游客模式] UID=${uid} Profile已取得，阻止后续登录跳转：${requestUrl}`
          );

          await route.abort();
          return;
        }

        await route.continue();
      }
    );

    console.log(
      `[SuperLike][Profile游客模式] UID=${uid} 使用匿名浏览器打开真实用户主页，等待页面自己的Profile XHR`
    );

    const maxAttempts = 2;
    const retryDelayMs = 500;
    const responseTimeoutMs = 7000;

    let result = null;

    for (
      let attempt = 1;
      attempt <= maxAttempts;
      attempt++
    ) {
      const startedAt =
        Date.now();

      let navigationError =
        null;

      try {
        const targetResponsePromise =
          profilePage.waitForResponse(
            response => {
              try {
                const responseUrl =
                  new URL(
                    response.url()
                  );

                if (
                  responseUrl.hostname !==
                    'm.weibo.cn'
                  ||
                  responseUrl.pathname !==
                    '/api/container/getIndex'
                ) {
                  return false;
                }

                const containerId =
                  responseUrl.searchParams.get(
                    'containerid'
                  );

                const extparam =
                  responseUrl.searchParams.get(
                    'extparam'
                  )
                  || '';

                return (
                  containerId ===
                    config.profileContainerId
                  &&
                  extparam.includes(
                    String(uid)
                  )
                );
              } catch {
                return false;
              }
            },
            {
              timeout:
                responseTimeoutMs
            }
          );

        /*
         * 每次都打开真实 H5 Profile 页面。
         * cache bust 避免第二次重试只命中浏览器缓存。
         */
        const attemptPageUrl =
          new URL(
            pageUrl.toString()
          );

        attemptPageUrl.searchParams.set(
          '_profile_retry',
          String(
            Date.now()
          )
        );

        const navigationPromise =
          profilePage.goto(
            attemptPageUrl.toString(),
            {
              waitUntil:
                'domcontentloaded',
              timeout:
                responseTimeoutMs
            }
          )
          .catch(
            error => {
              navigationError =
                error;

              console.log(
                `[SuperLike][Profile页面导航提示] UID=${uid} ${error.message}`
              );

              return null;
            }
          );

        const response =
          await targetResponsePromise;

        profileCaptured =
          true;

        /*
         * XHR 已经到手后，不要求页面最终停在哪儿。
         * 后续登录跳转会被 route 拦截。
         */
        await Promise.race([
          navigationPromise,
          profilePage.waitForTimeout(
            100
          )
        ]);

        const status =
          response.status();

        if (
          status >= 300
          &&
          status < 400
        ) {
          const location =
            response.headers()['location']
            || '';

          console.log(
            `[SuperLike][ProfileXHR重定向] UID=${uid} status=${status} location=${location || '-'}`
          );

          return {
            ok: false,
            blocked: false,
            visitorRedirect: true,
            hasSuperLike: null,
            status: 403,
            httpStatus: status,
            url:
              response.url(),
            message:
              `Profile XHR redirect ${status}${location ? ' -> ' + location : ''}`
          };
        }

        const text =
          await response.text();

        result = {
          ok:
            status >= 200
            &&
            status < 300,
          status,
          text,
          attempt,
          elapsedMs:
            Date.now()
            - startedAt,
          finalUrl:
            response.url(),
          error:
            null
        };

        console.log(
          `[SuperLike][ProfileResponse] UID=${uid} status=${status} attempt=${attempt}/${maxAttempts} elapsed=${result.elapsedMs}ms url=${result.finalUrl}`
        );

        if (
          status === 418
          ||
          status === 403
        ) {
          break;
        }

        const returnedHtml =
          text
            .trimStart()
            .startsWith('<');

        if (
          result.ok
          &&
          !returnedHtml
        ) {
          break;
        }

        if (
          attempt < maxAttempts
        ) {
          console.log(
            `[SuperLike][Profile请求重试] ${attempt}/${maxAttempts} 失败 | status=${status} | ${returnedHtml ? '返回HTML' : 'HTTP异常'} | ${retryDelayMs}ms后重试`
          );

          profileCaptured =
            false;

          await profilePage.waitForTimeout(
            retryDelayMs
          );
        }

      } catch (error) {
        const effectiveError =
          navigationError
          &&
          isProxyConnectionError(
            navigationError
          )
            ? navigationError
            : error;

        if (
          isProxyConnectionError(
            effectiveError
          )
        ) {
          console.log(
            `[SuperLike][Profile代理失败] UID=${uid} | ${effectiveError?.message || effectiveError} | 当前代理立即淘汰并切换`
          );

          throw effectiveError;
        }

        result = {
          ok: false,
          status: null,
          text: '',
          attempt,
          elapsedMs:
            Date.now()
            - startedAt,
          finalUrl:
            apiUrl,
          error:
            error.message
        };

        if (
          attempt < maxAttempts
        ) {
          console.log(
            `[SuperLike][Profile请求重试] ${attempt}/${maxAttempts} 失败 | status=- | error=${error.message} | ${retryDelayMs}ms后重试`
          );

          profileCaptured =
            false;

          await profilePage.waitForTimeout(
            retryDelayMs
          );

          continue;
        }
      }
    }

    if (
      !result
    ) {
      return {
        ok: false,
        hasSuperLike: null,
        status: null,
        url:
          apiUrl,
        message:
          'Profile 请求没有结果'
      };
    }

    if (
      result.error
    ) {
      if (
        isProxyConnectionError(
          result.error
        )
      ) {
        throw new Error(
          result.error
        );
      }

      return {
        ok: false,
        hasSuperLike: null,
        status:
          result.status,
        url:
          result.finalUrl,
        message:
          result.error
      };
    }

    if (
      !result.ok
    ) {
      return {
        ok: false,
        blocked:
          result.status === 418,
        hasSuperLike: null,
        status:
          result.status,
        url:
          result.finalUrl,
        message:
          `HTTP ${result.status}`
      };
    }

    console.log(
      `[SuperLike][Profile前100] ${result.text.slice(
        0,
        100
      )}`
    );

    if (
      result.text
        .trimStart()
        .startsWith('<')
    ) {
      return {
        ok: false,
        hasSuperLike: null,
        status:
          result.status,
        url:
          result.finalUrl,
        message:
          '返回HTML，不是JSON'
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
        hasSuperLike: null,
        status:
          result.status,
        url:
          result.finalUrl,
        message:
          `JSON解析失败：${error.message}`
      };
    }

    if (
      Number(
        json?.ok
        ?? 0
      )
      !== 1
    ) {
      const apiErrno =
        Number(
          json?.errno
        );

      return {
        ok: false,
        blocked: false,
        hasSuperLike: null,
        status:
          apiErrno === 403
            ? 403
            : result.status,
        httpStatus:
          result.status,
        apiErrno:
          Number.isFinite(
            apiErrno
          )
            ? apiErrno
            : null,
        url:
          result.finalUrl,
        message:
          apiErrno === 403
            ? 'API errno=403 请求被拒绝'
            : `API ok=${json?.ok}`
      };
    }

    const hasSuperLike =
      profileHasSuperLike(
        json
      );

    console.log(
      `[SuperLike][Profile结果] UID=${uid} SuperLike=${hasSuperLike}`
    );

    const experienceResult =
      await fetchSuperLikeExperience7d(
        context,
        config,
        uid
      );

    const experience7d =
      experienceResult?.ok
        ? experienceResult.experience7d
        : null;

    console.log(
      experienceResult?.ok
        ? `[SuperLike][经验值] UID=${uid} 近7天=${experience7d} | ${experienceResult.currentInfo || ''}`
        : `[SuperLike][经验值失败] UID=${uid} | ${experienceResult?.message || 'unknown'}`
    );

    const profilePosts =
      getProfilePosts(
        json,
        uid
      );

    console.log(
      `[SuperLike][Profile帖子] UID=${uid} 提取到=${profilePosts.length}条`
    );

    if (
      profilePosts.length > 0
    ) {
      const preview =
        profilePosts
          .slice(
            0,
            5
          )
          .map(
            (post, index) =>
              `#${index + 1} Post=${getPostId(post) || '-'} 评论=${getCommentsCount(post) ?? '-'} 时间=${getPostCreatedAt(post) || '-'}`
          );

      for (
        const line
        of preview
      ) {
        console.log(
          `[SuperLike][Profile帖子] ${line}`
        );
      }
    }

    return {
      ok: true,
      blocked: false,
      hasSuperLike,
      experience7d,
      profilePosts,
      status:
        result.status,
      url:
        result.finalUrl
    };

  } catch (error) {
    if (
      isProxyConnectionError(
        error
      )
    ) {
      throw error;
    }

    return {
      ok: false,
      blocked: false,
      hasSuperLike: null,
      status: null,
      url:
        apiUrl,
      message:
        error.message
    };

  } finally {
    if (
      profilePage
      &&
      !profilePage.isClosed()
    ) {
      try {
        await profilePage.close();
      } catch {
        // ignore
      }
    }

    if (
      profileContext
      &&
      ownsProfileContext
    ) {
      try {
        await profileContext.close();
      } catch {
        // ignore
      }
    }
  }
}

async function checkUserSuperLikeByProfile(
  context,
  config,
  uid,
  reusableProfileContext = null
) {
  let timer = null;

  const hardTimeout =
    new Promise(resolve => {
      timer =
        setTimeout(
          () => {
            console.log(
              `[SuperLike][Profile硬超时] UID=${uid} 超过${SCAN_PROFILE_HARD_TIMEOUT_MS / 1000}秒，立即fail-open，继续Scan。`
            );

            resolve({
              ok: false,
              hasSuperLike: null,
              status: null,
              url:
                buildProfileInPageApiUrl(
                  config,
                  uid
                ),
              message:
                `Profile hard timeout ${SCAN_PROFILE_HARD_TIMEOUT_MS}ms`
            });
          },
          SCAN_PROFILE_HARD_TIMEOUT_MS
        );
    });

  try {
    return await Promise.race([
      checkUserSuperLikeByProfileInner(
        context,
        config,
        uid,
        reusableProfileContext
      ),
      hardTimeout
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}


/**
 * ============================================================
 * Process Post Page
 * ============================================================
 */

async function processPagePosts(
  monitorId,
  json,
  seenThisRun,
  seenUidThisRun,
  deleteUidSet,
  checkpoint,
  context,
  config,
  profileCache,
  reusableProfileContext = null,
  preExtractedPosts = null
) {
  const stats = {
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
    profileFailed: 0,
    checkpointReached: false,
    pageFullyAtOrBeforeCheckpoint: false,
    pageHasNoPosts: false,
    newestSeen: null
  };


  const posts =
    Array.isArray(
      preExtractedPosts
    )
      ? preExtractedPosts
      : findPosts(
          json
        );


  stats.newestSeen =
    getNewestPostInfo(
      posts
    );

  stats.pageHasNoPosts =
    posts.length === 0;


  /*
   * 第二重 checkpoint 时间兜底：
   * 只有“整页所有可识别帖子都有有效时间，并且全部 <= checkpoint 时间”
   * 才把本页视为旧页。任何一条时间缺失/解析失败/晚于 checkpoint，
   * 本页都不计入连续旧页，避免误停。
   */
  if (
    checkpoint
    && Number.isFinite(Number(checkpoint.latest_created_at_ms))
    && posts.length > 0
  ) {
    const checkpointMs = Number(checkpoint.latest_created_at_ms);
    let comparablePosts = 0;
    let allComparable = true;
    let allAtOrBefore = true;

    for (const post of posts) {
      const postId = getPostId(post);

      if (!postId) {
        continue;
      }

      const createdAtMs = parsePostCreatedAtMs(post);

      if (!Number.isFinite(Number(createdAtMs))) {
        allComparable = false;
        allAtOrBefore = false;
        break;
      }

      comparablePosts++;

      if (Number(createdAtMs) > checkpointMs) {
        allAtOrBefore = false;
        break;
      }
    }

    stats.pageFullyAtOrBeforeCheckpoint =
      comparablePosts > 0
      && allComparable
      && allAtOrBefore;
  }


  for (
    const post
    of posts
  ) {
    const postId =
      getPostId(
        post
      );


    if (!postId) {
      continue;
    }


    if (
      seenThisRun.has(
        postId
      )
    ) {
      stats.duplicateInRun++;
      continue;
    }


    seenThisRun.add(
      postId
    );

    stats.found++;


    /*
     * 命中上一轮 checkpoint 时只做标记，不中断当前页。
     * 当前页剩余帖子仍全部处理，页处理完成后由外层停止翻页，
     * 防止同一页内部时间顺序不严格导致漏帖。
     */
    if (
      shouldStopAtCheckpoint(
        post,
        checkpoint
      )
    ) {
      if (!stats.checkpointReached) {
        console.log(
          `[SuperLike][Checkpoint] 本页发现上一轮 Post=${postId} time=${getPostCreatedAt(post) || '-'}；继续处理完整当前页。`
        );
      }

      stats.checkpointReached = true;
    }


    const uid =
      getUid(
        post
      );


    /*
     * 当天排除：
     * 某 UID 今天任意候选帖已经达到 21 评论后，
     * 今天剩余时间 scanner 不再抓取该 UID 的任何帖子。
     */
    if (
      uid
      &&
      isDailyExcludedUser(
        monitorId,
        uid
      )
    ) {
      console.log(
        `[SuperLike][当天排除] UID=${uid} 今天已有帖子达到21评论，跳过所有帖子`
      );
      continue;
    }


    /*
     * 第一层：superlike_users 是最高优先级本地黑名单。
     * 已确认 SuperLike 的 UID 不需要再看 feed icon / Profile。
     */
    if (
      uid
      &&
      isSuperLikeUser(
        uid
      )
    ) {
      stats.hasSuperLike++;

      if (!deleteUidSet.has(uid)) {
        stats.deleteQueued++;
      }

      deleteUidSet.add(uid);

      console.log(
        `[SuperLike][本地命中] UID=${uid} 已存在 superlike_users，直接忽略`
      );

      continue;
    }


    if (
      hasSuperLike(
        post
      )
    ) {
      stats.hasSuperLike++;

      if (uid) {
        if (!deleteUidSet.has(uid)) {
          stats.deleteQueued++;
        }

        deleteUidSet.add(uid);

        const userInserted =
          saveSuperLikeUser(monitorId, uid);

        console.log(
          userInserted
            ? `[SuperLike][SuperLike用户入库] UID=${uid} 已写入 superlike_users`
            : `[SuperLike][SuperLike用户已存在] UID=${uid} superlike_users 已有记录`
        );

        console.log(
          `[SuperLike][待删除] UID=${uid} feed Response发现 chao_like`
        );
      }

      continue;
    }


    /*
     * 先检查评论数，再做“同 UID 本轮只保留一条”的去重。
     *
     * 原因：
     * 即使这个 UID 较新的帖子已经被处理过，
     * 后面又遇到他的另一条帖子只要评论 >=21，
     * 也必须立刻把该 UID 加入当天排除并删除已有候选。
     */
    const commentsCount =
      getCommentsCount(
        post
      );


    if (
      commentsCount === null
    ) {
      stats.unknownComments++;
      continue;
    }


    if (
      commentsCount >=
      MAX_COMMENTS
    ) {
      stats.commentsFull++;

      if (uid) {
        markDailyExcludedUser(
          monitorId,
          uid,
          'COMMENTS_21'
        );

        const deletedNow =
          deletePostsByUidWithLog(
            uid,
            'COMMENTS_21'
          );

        console.log(
          `[SuperLike][评论>=21当天排除] UID=${uid} | Post=${postId} | 评论=${commentsCount} | 清理旧候选=${deletedNow}`
        );
      }

      continue;
    }


    /*
     * 每个用户只处理这一轮里遇到的第一条“未满21评论”的帖子。
     * 但其它帖子仍会经过上面的 >=21 检查，确保不会漏掉当天排除条件。
     */
    if (
      uid
      &&
      seenUidThisRun.has(
        uid
      )
    ) {
      stats.duplicateUidInRun++;
      continue;
    }


    if (uid) {
      seenUidThisRun.add(uid);
    }


    if (!uid) {
      console.log(
        `[SuperLike][跳过] Post=${postId} 没有UID，不入库`
      );

      continue;
    }


    /*
     * feed 没有超LIKE icon，且 UID 也不在 superlike_users：
     * 先做 Profile 二次校验。
     *
     * 1) 同一轮同 UID 只请求一次。
     * 2) DB 最近15分钟已经确认 NO_SUPERLIKE 时直接复用。
     * 3) Profile 确认 SuperLike -> 立刻入 superlike_users 并清旧候选。
     * 4) Profile 请求失败时 fail-open：仍允许候选入库，避免漏掉真正目标。
     */
    let profileResult =
      profileCache.get(uid)
      || null;

    if (!profileResult) {
      const recent =
        getRecentSuperLikeProfileStatus(
          monitorId,
          uid,
          SCAN_PROFILE_CACHE_MINUTES
        );

      if (
        recent
        &&
        String(recent.status).toUpperCase()
          === 'NO_SUPERLIKE'
      ) {
        /*
         * 以前这里会直接复用 NO_SUPERLIKE 缓存。
         * 现在还需要核对“原 post 是否仍在用户超话主页”并寻找替代帖，
         * 所以 scanner 必须拿到本轮真实 profile JSON，不能只靠状态缓存。
         */
        console.log(
          `[SuperLike][Profile缓存仅状态] UID=${uid} 最近已确认非SuperLike，但本轮仍请求主页用于帖子核对`
        );
      }
    }

    if (!profileResult) {
      stats.profileChecked++;

      console.log(
        `[SuperLike][Profile校验] UID=${uid} feed无超LIKE，开始二次确认...`
      );

      profileResult =
        await checkUserSuperLikeByProfile(
          context,
          config,
          uid,
          reusableProfileContext
        );

      profileCache.set(
        uid,
        profileResult
      );
    }

    if (
      profileResult?.ok
      &&
      profileResult.hasSuperLike
    ) {
      stats.hasSuperLike++;
      stats.profileSuperLike++;

      const userInserted =
        saveSuperLikeUser(
          monitorId,
          uid
        );

      const deletedNow =
        deletePostsByUidWithLog(
          uid,
          'SUPERLIKE_PROFILE_CONFIRMED'
        );

      if (!deleteUidSet.has(uid)) {
        stats.deleteQueued++;
      }

      deleteUidSet.add(uid);

      console.log(
        `[SuperLike][Profile命中] UID=${uid} 已确认SuperLike | ` +
        `${userInserted ? '写入' : '已存在'} superlike_users | 清理旧候选=${deletedNow}`
      );

      continue;
    }

    if (
      profileResult?.ok
      &&
      profileResult.hasSuperLike === false
      &&
      Number.isFinite(
        Number(
          profileResult.experience7d
        )
      )
      &&
      Number(
        profileResult.experience7d
      ) > 80
    ) {
      stats.hasSuperLike++;

      const userInserted =
        saveSuperLikeUser(
          monitorId,
          uid
        );

      const deletedNow =
        deletePostsByUidWithLog(
          uid,
          'SUPERLIKE_EXPERIENCE_GT_80'
        );

      if (!deleteUidSet.has(uid)) {
        stats.deleteQueued++;
      }

      deleteUidSet.add(uid);

      console.log(
        `[SuperLike][经验值判定SuperLike] UID=${uid} | jyz=${profileResult.experience7d} > 80 | Profile虽未显示超LIKE，仍按SuperLike处理 | ${userInserted ? '写入' : '已存在'} superlike_users | 清理旧候选=${deletedNow}`
      );

      continue;
    }


    if (
      profileResult
      &&
      !profileResult.ok
    ) {
      stats.profileFailed++;

      console.log(
        `[SuperLike][Profile失败] UID=${uid} | ${profileResult.message || 'unknown'} | Profile最多2次、单次5秒，整体最多15秒；失败后fail-open入库，后续交给Mode3/删除Batch清理`
      );
    }


    /*
     * 新逻辑：候选必须在该用户当前超话主页里有可用落点。
     *
     * - 原 post_id 仍在主页：保留原帖。
     * - 原 post_id 不在主页：换成主页从上往下第一条“30天内 + 评论0~3”的帖子。
     * - 主页请求成功，但两者都没有：这个 UID 不保留候选，并删除 DB 中该 UID 旧候选。
     * - Profile 请求失败：仍 fail-open，保留原帖，避免网络失败误删用户。
     */
    let targetPost = post;

    if (
      profileResult?.ok
      &&
      Array.isArray(profileResult.profilePosts)
    ) {
      const profilePosts =
        profileResult.profilePosts;

      const originalOnProfile =
        profilePosts.some(
          profilePost =>
            String(
              getPostId(
                profilePost
              )
            )
            ===
            String(
              postId
            )
        );

      console.log(
        `[SuperLike][Profile原帖检查] UID=${uid} FeedPost=${postId} | ${originalOnProfile ? 'FOUND' : 'NOT_FOUND'}`
      );

      if (!originalOnProfile) {
        const replacementPost =
          pickProfileReplacementPost(
            profilePosts
          );

        if (replacementPost) {
          targetPost =
            replacementPost;

          console.log(
            `[SuperLike][主页替换] UID=${uid} 原Post=${postId} 不在主页 -> 替换为 Post=${getPostId(replacementPost)} 评论=${getCommentsCount(replacementPost)} 时间=${getPostCreatedAt(replacementPost) || '-'}`
          );
        } else {
          const deletedNow =
            deletePostsByUidWithLog(
              uid,
              'PROFILE_NO_USABLE_POST'
            );

          console.log(
            `[SuperLike][PROFILE_NO_USABLE_POST][本来应该入库→被扔掉] UID=${uid} | FeedPost=${postId} | Feed评论=${commentsCount} | 原帖不在Profile主页 | 30天内无评论1~4替代帖 | 原逻辑保持：不入库并清理旧候选=${deletedNow}`
          );

          continue;
        }
      } else {
        console.log(
          `[SuperLike][主页命中原帖] UID=${uid} Post=${postId} 仍在超话主页，保持原帖`
        );
      }
    }

    stats.target++;


    try {
      const saved =
        saveTargetPost(
          monitorId,
          targetPost,
          profileResult
          && !profileResult.ok
          && Number(profileResult.status) !== 403
            ? 'PROFILE_FAILED'
            : (
                profileResult?.ok
                && profileResult.hasSuperLike === false
                  ? 'NO_SUPERLIKE'
                  : 'UNKNOWN'
              ),
          profileResult?.experience7d
          ?? null
        );


      if (
        saved.status ===
        'inserted'
      ) {
        stats.inserted++;

        console.log(
          [
            '[SuperLike][新增]',
            `UID=${saved.uid || '-'}`,
            `用户=${saved.username || '-'}`,
            `评论=${saved.commentsCount}`,
            `经验7D=${saved.experience7d ?? '-'}`,
            `Icon=${saved.iconSummary || '无'}`,
            saved.postLink || '-'
          ].join(' | ')
        );

      } else if (
        saved.status ===
        'replaced'
      ) {
        stats.replaced++;

        console.log(
          [
            '[SuperLike][更新UID最新帖]',
            `UID=${saved.uid || '-'}`,
            `用户=${saved.username || '-'}`,
            `评论=${saved.commentsCount}`,
            `经验7D=${saved.experience7d ?? '-'}`,
            saved.postLink || '-'
          ].join(' | ')
        );

      } else if (
        saved.status ===
        'kept_existing'
      ) {
        stats.existingInDb++;
      }

      if (
        profileResult?.ok
        &&
        profileResult.hasSuperLike === false
      ) {
        markSuperLikeProfileChecked(
          monitorId,
          uid,
          'NO_SUPERLIKE'
        );
      }

    } catch (error) {
      if (
        String(
          error.message
        )
          .toLowerCase()
          .includes(
            'unique'
          )
      ) {
        stats.existingInDb++;
        continue;
      }

      throw error;
    }
  }


  return stats;
}


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
      __dirname,
      '..',
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
      forceLocal
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
        : '[SuperLike] 当前轮使用本地IP'
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


    const feedResult =
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
    const sortTimeFlowId =
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


    const firstSortTimeResult =
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
    const sortTimeRequestTemplateUrl =
      firstSortTimeResult.url;

    const sortTimeRequestTemplateHeaders =
      firstSortTimeResult.requestHeaders
      ||
      {};


    let current =
      firstSortTimeResult;

    let logicalPageNumber = 1;

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
        firstSortTimeResult.requestHeaders
        || feedResult.requestHeaders
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
                scanVisitorContext
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
                `剩余预算=${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))}秒`
              ].join(' | ')
            );

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
            scanVisitorContext
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
            `更新UID=${pageStats.replaced}`
          ].join(' | ')
        );

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
            firstSortTimeResult.requestHeaders
            || feedResult.requestHeaders
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
        feedResult.requestHeaders
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