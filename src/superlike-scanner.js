const path = require('path');
const { chromium } = require('playwright');
const { db, initDatabase } = require('./db');


/**
 * ============================================================
 * SuperLike 新帖扫描 Batch
 *
 * 逻辑：
 *
 * 手动启动
 * ↓
 * 立即扫描一次
 * ↓
 * 每15分钟重新从第1页开始
 * ↓
 * 最多扫描50页
 * ↓
 * post_id查数据库
 * ↓
 * 累计遇到10条数据库已经存在的post_id
 * ↓
 * 当前页处理完后结束本轮
 * ↓
 * 新Post：
 *   评论 < 20
 *   没有 chao_like
 * ↓
 * 入库
 *
 * npm run scan-superlike
 * ============================================================
 */


const SCAN_INTERVAL_MS =
  15 * 60 * 1000;

const MAX_PAGES =
  50;

const EXISTING_STOP_THRESHOLD =
  10;

const PAGE_DELAY_MS =
  500;

const MAX_COMMENTS =
  20;


let running = false;


/**
 * ============================================================
 * 初始化
 * ============================================================
 */

function initSuperLikeTable() {

  initDatabase();

}


/**
 * ============================================================
 * 从 monitors 表获取 SuperLike Monitor
 * ============================================================
 */

function getSuperLikeMonitors() {

  initDatabase();


  return db.prepare(`
    SELECT
      id,
      name,
      url,
      enabled,
      monitor_type
    FROM monitors
    WHERE enabled = 1
      AND monitor_type = 'superlike'
    ORDER BY id
  `).all();

}


/**
 * ============================================================
 * HTML → 普通文本
 * ============================================================
 */

function stripHtml(value) {

  if (
    value === null ||
    value === undefined
  ) {

    return '';

  }


  return String(value)

    .replace(
      /<br\s*\/?>/gi,
      '\n'
    )

    .replace(
      /<[^>]+>/g,
      ''
    )

    .replace(
      /&nbsp;/gi,
      ' '
    )

    .replace(
      /&lt;/gi,
      '<'
    )

    .replace(
      /&gt;/gi,
      '>'
    )

    .replace(
      /&amp;/gi,
      '&'
    )

    .replace(
      /&quot;/gi,
      '"'
    )

    .replace(
      /&#39;/gi,
      "'"
    )

    .trim();

}


/**
 * ============================================================
 * Post ID
 * ============================================================
 */

function getPostId(post) {

  const value =

    post?.idstr
    ??
    post?.mid
    ??
    post?.id;


  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {

    return '';

  }


  return String(value);

}


/**
 * ============================================================
 * UID
 * ============================================================
 */

function getUid(post) {

  const value =

    post?.user?.idstr
    ??
    post?.user?.id
    ??
    post?.uid;


  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {

    return '';

  }


  return String(value);

}


/**
 * ============================================================
 * 用户名
 * ============================================================
 */

function getUsername(post) {

  return (

    post?.user?.screen_name
    ??
    post?.user?.name
    ??
    null

  );

}


/**
 * ============================================================
 * 帖子正文
 * ============================================================
 */

function getPostText(post) {

  return stripHtml(

    post?.text
    ??
    post?.raw_text
    ??
    post?.text_raw
    ??
    ''

  );

}


/**
 * ============================================================
 * 评论数量
 *
 * 取不到返回 null
 * 不会错误当成0
 * ============================================================
 */

function getCommentsCount(post) {

  const value =

    post?.comments_count
    ??
    post?.comment_count;


  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {

    return null;

  }


  const number =
    Number(value);


  if (
    !Number.isFinite(number)
  ) {

    return null;

  }


  return number;

}


/**
 * ============================================================
 * 发布时间
 * ============================================================
 */

function getPostCreatedAt(post) {

  const value =

    post?.created_at
    ??
    post?.createdAt
    ??
    null;


  return value
    ? String(value)
    : null;

}


/**
 * ============================================================
 * 微博链接
 * ============================================================
 */

function getPostLink(post) {

  const candidates = [

    post?.url,

    post?.mblog_url,

    post?.detail_url,

    post?.scheme

  ];


  for (
    const value
    of candidates
  ) {

    if (
      typeof value === 'string'
      &&
      /^https?:\/\//i.test(value)
      &&
      value
        .toLowerCase()
        .includes('weibo')
    ) {

      return value;

    }

  }


  const postId =
    getPostId(post);


  if (postId) {

    return (
      `https://m.weibo.cn/detail/${postId}`
    );

  }


  return '';

}


/**
 * ============================================================
 * 判断一个对象是否像微博 Post
 * ============================================================
 */

function looksLikePost(obj) {

  if (
    !obj ||
    typeof obj !== 'object' ||
    Array.isArray(obj)
  ) {

    return false;

  }


  const postId =

    obj.idstr
    ??
    obj.mid
    ??
    obj.id;


  if (!postId) {

    return false;

  }


  if (!obj.user) {

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

  );

}


/**
 * ============================================================
 * 从 Response JSON 递归寻找 Post
 * ============================================================
 */

function findPosts(
  value,
  result = [],
  visited = new Set()
) {

  if (
    !value ||
    typeof value !== 'object'
  ) {

    return result;

  }


  if (
    visited.has(value)
  ) {

    return result;

  }


  visited.add(value);


  if (
    looksLikePost(value)
  ) {

    result.push(value);

  }


  if (
    Array.isArray(value)
  ) {

    for (
      const item
      of value
    ) {

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
      child &&
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


/**
 * ============================================================
 * 判断用户是否已有 SuperLike
 *
 * 只检查 user JSON。
 *
 * 避免正文出现“超Like”导致误判。
 * ============================================================
 */

function hasSuperLike(post) {

  if (!post?.user) {

    return false;

  }


  let text;


  try {

    text =
      JSON.stringify(
        post.user
      )
        .toLowerCase();

  } catch {

    return false;

  }


  return (

    text.includes(
      'chao_like'
    )

    ||

    text.includes(
      'chaolike'
    )

    ||

    text.includes(
      'chao-like'
    )

    ||

    text.includes(
      'super_like'
    )

    ||

    text.includes(
      'superlike'
    )

    ||

    text.includes(
      '超like'
    )

  );

}


/**
 * ============================================================
 * 提取当前 Icon
 * ============================================================
 */

function extractIcons(post) {

  const user =
    post?.user;


  if (!user) {

    return [];

  }


  const result =
    new Set();


  const visited =
    new Set();


  const iconKeyPattern =

    /icon|badge|medal|label|level|pendant|title/i;


  function walk(
    value,
    keyName = ''
  ) {

    if (
      value === null ||
      value === undefined
    ) {

      return;

    }


    if (
      typeof value === 'string'
    ) {

      if (
        !iconKeyPattern.test(
          keyName
        )
      ) {

        return;

      }


      const text =
        value.trim();


      if (
        !text ||
        text.length > 100
      ) {

        return;

      }


      if (
        /^https?:\/\//i.test(text)
      ) {

        return;

      }


      if (

        /chao[_-]?like|chaolike|super[_-]?like|superlike|超like/i
          .test(text)

      ) {

        return;

      }


      result.add(text);


      return;

    }


    if (
      typeof value !== 'object'
    ) {

      return;

    }


    if (
      visited.has(value)
    ) {

      return;

    }


    visited.add(value);


    if (
      Array.isArray(value)
    ) {

      for (
        const item
        of value
      ) {

        walk(
          item,
          keyName
        );

      }


      return;

    }


    for (
      const [key, child]
      of Object.entries(value)
    ) {

      walk(
        child,
        key
      );

    }

  }


  walk(user);


  return Array.from(
    result
  );

}


/**
 * ============================================================
 * DB 是否已经存在 post_id
 *
 * 这里按 post_id 全局判断。
 * ============================================================
 */

function postIdExists(postId) {

  if (!postId) {

    return false;

  }


  const row =
    db.prepare(`
      SELECT id
      FROM superlike_posts
      WHERE post_id = ?
      LIMIT 1
    `).get(
      postId
    );


  return !!row;

}


/**
 * ============================================================
 * 保存候选 Post
 * ============================================================
 */

function saveTargetPost(
  monitorId,
  post
) {

  const postId =
    getPostId(post);


  if (!postId) {

    return {
      status: 'skip'
    };

  }


  const commentsCount =
    getCommentsCount(post);


  if (
    commentsCount === null
  ) {

    return {
      status: 'skip'
    };

  }


  if (
    commentsCount >= MAX_COMMENTS
  ) {

    return {
      status: 'skip'
    };

  }


  if (
    hasSuperLike(post)
  ) {

    return {
      status: 'skip'
    };

  }


  const uid =
    getUid(post);


  const username =
    getUsername(post);


  const postLink =
    getPostLink(post);


  const postText =
    getPostText(post);


  const postCreatedAt =
    getPostCreatedAt(post);


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


  db.prepare(`
    INSERT INTO superlike_posts(

      monitor_id,

      post_id,

      uid,

      username,

      post_link,

      post_text,

      comments_count,

      current_has_superlike,

      icon_summary,

      experience_7d,

      post_created_at,

      first_seen_at,

      last_seen_at,

      raw_json

    )

    VALUES(

      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,

      0,

      ?,

      NULL,

      ?,

      CURRENT_TIMESTAMP,

      CURRENT_TIMESTAMP,

      ?

    )
  `).run(

    monitorId,

    postId,

    uid || null,

    username,

    postLink || null,

    postText,

    commentsCount,

    iconSummary,

    postCreatedAt,

    rawJson

  );


  return {

    status:
      'inserted',

    postId,

    uid,

    username,

    postLink,

    commentsCount,

    iconSummary

  };

}


/**
 * ============================================================
 * 构造第一页 URL
 *
 * 无论 monitors.json 写 page=几：
 *
 * 每轮都：
 *
 * page=1
 * 删除 since_id
 * max_id=0
 * ============================================================
 */

function buildFirstPageUrl(
  monitorUrl
) {

  const url =
    new URL(
      String(
        monitorUrl
      ).trim()
    );


  url.searchParams.set(
    'page',
    '1'
  );


  url.searchParams.delete(
    'since_id'
  );


  url.searchParams.set(
    'max_id',
    '0'
  );


  return url;

}


/**
 * ============================================================
 * since_id 转换
 * ============================================================
 */

function normalizeSinceId(value) {

  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {

    return null;

  }


  if (
    typeof value === 'object'
  ) {

    return JSON.stringify(
      value
    );

  }


  return String(value);

}


/**
 * ============================================================
 * 从 Response 获取下一页 since_id
 * ============================================================
 */

function extractNextSinceId(json) {

  const candidates = [

    json?.data?.cardlistInfo?.since_id,

    json?.data?.pageInfo?.since_id,

    json?.data?.since_id,

    json?.cardlistInfo?.since_id,

    json?.pageInfo?.since_id,

    json?.since_id

  ];


  for (
    const value
    of candidates
  ) {

    const normalized =
      normalizeSinceId(value);


    if (normalized) {

      return normalized;

    }

  }


  /**
   * 上面的固定位置没找到，
   * 再递归寻找 since_id。
   */

  const visited =
    new Set();


  function walk(value) {

    if (
      !value ||
      typeof value !== 'object'
    ) {

      return null;

    }


    if (
      visited.has(value)
    ) {

      return null;

    }


    visited.add(value);


    if (
      !Array.isArray(value)
      &&
      Object.prototype.hasOwnProperty.call(
        value,
        'since_id'
      )
    ) {

      const normalized =
        normalizeSinceId(
          value.since_id
        );


      if (normalized) {

        return normalized;

      }

    }


    const children =

      Array.isArray(value)

        ? value

        : Object.values(value);


    for (
      const child
      of children
    ) {

      const found =
        walk(child);


      if (found) {

        return found;

      }

    }


    return null;

  }


  return walk(json);

}


/**
 * ============================================================
 * 构造指定页 URL
 * ============================================================
 */

function buildPageUrl(
  baseUrl,
  pageNumber,
  sinceId
) {

  const url =
    new URL(
      baseUrl.toString()
    );


  url.searchParams.set(
    'page',
    String(pageNumber)
  );


  url.searchParams.set(
    'max_id',
    '0'
  );


  if (
    pageNumber === 1
  ) {

    url.searchParams.delete(
      'since_id'
    );

  } else {

    if (sinceId) {

      url.searchParams.set(
        'since_id',
        sinceId
      );

    } else {

      url.searchParams.delete(
        'since_id'
      );

    }

  }


  return url.toString();

}


/**
 * ============================================================
 * 请求 API
 *
 * 为什么仍然用 Playwright？
 *
 * 因为可以继续使用：
 *
 * data/superlike-browser-profile
 *
 * 里的微博登录 Cookie。
 *
 * 不需要自己处理 Cookie。
 * ============================================================
 */

async function requestJsonPage(
  page,
  url
) {

  const response =
    await page.goto(
      url,
      {

        waitUntil:
          'domcontentloaded',

        timeout:
          60 * 1000

      }
    );


  if (!response) {

    throw new Error(
      '没有收到HTTP Response'
    );

  }


  const status =
    response.status();


  if (
    status < 200 ||
    status >= 300
  ) {

    throw new Error(
      `HTTP ${status}`
    );

  }


  try {

    return await response.json();

  } catch {

    /**
     * 如果 Response.json() 失败，
     * 尝试读取浏览器页面正文。
     */

    const bodyText =
      await page
        .locator('body')
        .innerText();


    return JSON.parse(
      bodyText
    );

  }

}


/**
 * ============================================================
 * 处理一页数据
 * ============================================================
 */

function processPagePosts(
  monitorId,
  json,
  seenThisRun
) {

  const result = {

    found: 0,

    duplicateInRun: 0,

    existingInDb: 0,

    unknownComments: 0,

    commentsFull: 0,

    hasSuperLike: 0,

    target: 0,

    inserted: 0

  };


  const posts =
    findPosts(json);


  for (
    const post
    of posts
  ) {

    const postId =
      getPostId(post);


    if (!postId) {

      continue;

    }


    /**
     * Response内部重复
     */

    if (
      seenThisRun.has(
        postId
      )
    ) {

      result.duplicateInRun++;

      continue;

    }


    seenThisRun.add(
      postId
    );


    result.found++;


    /**
     * ======================================
     * 最先检查数据库
     * ======================================
     */

    if (
      postIdExists(
        postId
      )
    ) {

      result.existingInDb++;

      continue;

    }


    /**
     * ======================================
     * 评论数
     * ======================================
     */

    const commentsCount =
      getCommentsCount(post);


    if (
      commentsCount === null
    ) {

      result.unknownComments++;

      continue;

    }


    if (
      commentsCount >= MAX_COMMENTS
    ) {

      result.commentsFull++;

      continue;

    }


    /**
     * ======================================
     * SuperLike
     * ======================================
     */

    if (
      hasSuperLike(post)
    ) {

      result.hasSuperLike++;

      continue;

    }


    /**
     * ======================================
     * 候选
     * ======================================
     */

    result.target++;


    const saved =
      saveTargetPost(
        monitorId,
        post
      );


    if (
      saved.status ===
      'inserted'
    ) {

      result.inserted++;


      console.log(

        [

          '[SuperLike][新增]',

          `UID=${saved.uid || '-'}`,

          `用户=${saved.username || '-'}`,

          `评论=${saved.commentsCount}`,

          `Icon=${saved.iconSummary || '无'}`,

          saved.postLink || '-'

        ].join(' | ')

      );

    }

  }


  return result;

}


/**
 * ============================================================
 * 扫描一个 Monitor
 * ============================================================
 */

async function scanOneSuperLikeMonitor(
  monitor
) {

  const monitorUrl =
    String(
      monitor.url || ''
    ).trim();


  if (!monitorUrl) {

    console.error(
      `[SuperLike] ${monitor.name} URL为空`
    );

    return;

  }


  let firstPageUrl;


  try {

    firstPageUrl =
      buildFirstPageUrl(
        monitorUrl
      );

  } catch {

    console.error(
      `[SuperLike] URL无效：${monitorUrl}`
    );

    return;

  }


  const profileDir =
    path.join(

      __dirname,

      '..',

      'data',

      'superlike-browser-profile'

    );


  let browser = null;


  const seenThisRun =
    new Set();


  let totalExisting =
    0;


  let pagesScanned =
    0;


  let stopReason =
    `达到最大 ${MAX_PAGES} 页`;


  const total = {

    found: 0,

    duplicateInRun: 0,

    existingInDb: 0,

    unknownComments: 0,

    commentsFull: 0,

    hasSuperLike: 0,

    target: 0,

    inserted: 0

  };


  const startedAt =
    Date.now();


  try {

    console.log('');
    console.log(
      '=========================================='
    );

    console.log(
      `SuperLike：${monitor.name}`
    );

    console.log(
      `Monitor ID：${monitor.id}`
    );

    console.log(
      `最多扫描：${MAX_PAGES}页`
    );

    console.log(
      `旧Post停止阈值：${EXISTING_STOP_THRESHOLD}`
    );

    console.log(
      '=========================================='
    );


    browser =
      await chromium
        .launchPersistentContext(

          profileDir,

          {

            headless:
              process.env
                .SUPERLIKE_HEADLESS
              === '1',

            viewport: {

              width: 1280,

              height: 900

            }

          }

        );


    const page =

      browser.pages()[0]

      ||

      await browser.newPage();


    let sinceId =
      null;


    /**
     * ========================================================
     * 最多50页
     * ========================================================
     */

    for (

      let pageNumber = 1;

      pageNumber <= MAX_PAGES;

      pageNumber++

    ) {

      const requestUrl =
        buildPageUrl(

          firstPageUrl,

          pageNumber,

          sinceId

        );


      console.log('');
      console.log(
        `[SuperLike] 请求第 ${pageNumber}/${MAX_PAGES} 页`
      );


      console.log(
        requestUrl
      );


      let json;


      try {

        json =
          await requestJsonPage(

            page,

            requestUrl

          );

      } catch (error) {

        console.error(
          `[SuperLike] 第${pageNumber}页请求失败：`,
          error.message
        );


        stopReason =
          `第${pageNumber}页请求失败`;


        break;

      }


      pagesScanned++;


      /**
       * ======================================
       * 处理当前页
       * ======================================
       */

      const stats =
        processPagePosts(

          monitor.id,

          json,

          seenThisRun

        );


      for (
        const key
        of Object.keys(total)
      ) {

        total[key] +=
          stats[key] || 0;

      }


      totalExisting +=
        stats.existingInDb;


      console.log(

        [

          `[第${pageNumber}页]`,

          `Post=${stats.found}`,

          `DB已存在=${stats.existingInDb}`,

          `累计旧Post=${totalExisting}`,

          `评论>=20=${stats.commentsFull}`,

          `有SuperLike=${stats.hasSuperLike}`,

          `新增=${stats.inserted}`

        ].join(' | ')

      );


      /**
       * ======================================================
       * 累计10个旧Post → 停止
       *
       * 当前页已经全部处理完成，
       * 所以不会漏当前页后面的新Post。
       * ======================================================
       */

      if (
        totalExisting
        >=
        EXISTING_STOP_THRESHOLD
      ) {

        stopReason =
          `累计发现 ${totalExisting} 条数据库已有Post`;


        console.log(
          '[SuperLike] 已进入旧数据区域，本轮提前结束。'
        );


        break;

      }


      /**
       * ======================================================
       * 获取下一页 cursor
       * ======================================================
       */

      const nextSinceId =
        extractNextSinceId(
          json
        );


      if (!nextSinceId) {

        stopReason =
          `第${pageNumber}页没有下一页 since_id`;


        console.log(
          '[SuperLike] 没有找到下一页 since_id。'
        );


        break;

      }


      /**
       * 防止 cursor 死循环
       */

      if (
        sinceId !== null
        &&
        String(nextSinceId)
        === String(sinceId)
      ) {

        stopReason =
          'since_id没有变化';


        console.log(
          '[SuperLike] since_id没有变化，停止。'
        );


        break;

      }


      sinceId =
        nextSinceId;


      /**
       * 每页之间稍微等一下
       */

      if (
        PAGE_DELAY_MS > 0
      ) {

        await page.waitForTimeout(
          PAGE_DELAY_MS
        );

      }

    }


    /**
     * ========================================================
     * 本轮统计
     * ========================================================
     */

    console.log('');
    console.log(
      '============== 本轮结果 =============='
    );


    console.log(
      '扫描页数：',
      pagesScanned
    );


    console.log(
      '扫描Post：',
      total.found
    );


    console.log(
      'Response重复：',
      total.duplicateInRun
    );


    console.log(
      '数据库已有：',
      total.existingInDb
    );


    console.log(
      '评论数未知：',
      total.unknownComments
    );


    console.log(
      '评论>=20：',
      total.commentsFull
    );


    console.log(
      '已有SuperLike：',
      total.hasSuperLike
    );


    console.log(
      '符合候选：',
      total.target
    );


    console.log(
      '本轮新增：',
      total.inserted
    );


    console.log(
      '停止原因：',
      stopReason
    );


    console.log(
      '耗时：',
      `${Math.round(
        (
          Date.now()
          -
          startedAt
        )
        /
        1000
      )}秒`
    );


    console.log(
      '======================================'
    );


  } finally {

    if (browser) {

      try {

        await browser.close();

      } catch {

        // ignore

      }

    }

  }

}


/**
 * ============================================================
 * 扫描所有 SuperLike Monitor
 * ============================================================
 */

async function scanSuperLikePosts() {

  if (running) {

    console.log(
      '[SuperLike] 上一轮还没结束，本轮跳过。'
    );


    return;

  }


  running =
    true;


  try {

    initDatabase();


    const monitors =
      getSuperLikeMonitors();


    if (
      monitors.length === 0
    ) {

      console.log('');
      console.log(
        '[SuperLike] 没有启用的SuperLike Monitor。'
      );


      console.log(
        "需要 monitor_type='superlike' AND enabled=1"
      );


      return;

    }


    console.log('');
    console.log(
      `[SuperLike] 共 ${monitors.length} 个Monitor`
    );


    /**
     * 顺序执行
     */

    for (
      const monitor
      of monitors
    ) {

      try {

        await scanOneSuperLikeMonitor(
          monitor
        );

      } catch (error) {

        console.error(
          `[SuperLike] ${monitor.name} 扫描失败：`,
          error
        );

      }

    }


  } finally {

    running =
      false;

  }

}


/**
 * ============================================================
 * Batch
 *
 * 手动启动：
 *
 * npm run scan-superlike
 *
 * 启动：
 *   立即执行一次
 *
 * 之后：
 *   每15分钟执行一次
 * ============================================================
 */

async function startSuperLikeBatch() {

  initDatabase();


  console.log('');
  console.log(
    '########################################'
  );

  console.log(
    '# SuperLike Batch'
  );

  console.log(
    '# 每15分钟从第1页重新扫描'
  );

  console.log(
    '# 最多50页'
  );

  console.log(
    '# 累计10个数据库已有Post后停止'
  );

  console.log(
    '# 评论<20 + 无SuperLike → 入库'
  );

  console.log(
    '# Ctrl+C 停止'
  );

  console.log(
    '########################################'
  );


  /**
   * 第一轮立即执行
   */

  await scanSuperLikePosts();


  /**
   * 每15分钟
   */

  setInterval(

    async () => {

      console.log('');
      console.log(
        '[SuperLike] 15分钟到，从第1页重新扫描。'
      );


      try {

        await scanSuperLikePosts();

      } catch (error) {

        console.error(
          '[SuperLike] 定时扫描失败：',
          error
        );

      }

    },

    SCAN_INTERVAL_MS

  );

}


/**
 * ============================================================
 * Ctrl+C
 * ============================================================
 */

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


/**
 * ============================================================
 * exports
 * ============================================================
 */

module.exports = {

  initSuperLikeTable,

  getSuperLikeMonitors,

  scanSuperLikePosts,

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

  buildFirstPageUrl,

  buildPageUrl,

  extractNextSinceId

};


/**
 * ============================================================
 * 只有直接执行 scanner 才启动 Batch。
 *
 * npm start 不会运行这里。
 * ============================================================
 */

if (
  require.main === module
) {

  startSuperLikeBatch()

    .catch(

      error => {

        console.error(
          '[SuperLike] Batch启动失败：',
          error
        );


        process.exit(1);

      }

    );

}