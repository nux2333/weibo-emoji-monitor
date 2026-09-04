const {
  createBatchLogger
} = require('../src/batch-logger');


const batchLogger =
  createBatchLogger(
    'recheck-superlike'
  );
  
const path = require('path');
const readline = require('readline');

const {
  db,
  initDatabase
} = require('../src/db');

const {
  parseTopicHomepage,
  checkUserSuperLikeByProfile
} = require('../src/superlike-scanner');


/**
 * ============================================================
 * 配置
 * ============================================================
 */

/*
 * 打开帖子后等待多久。
 */
const POST_WAIT_MS =
  Number(
    process.env.SUPERLIKE_RECHECK_POST_WAIT_MS
  )
  || 2500;


/*
 * 两个用户 Profile 检查之间稍微停一下。
 */
const PROFILE_DELAY_MS =
  Number(
    process.env.SUPERLIKE_RECHECK_PROFILE_DELAY_MS
  )
  || 500;


/*
 * 两个帖子检查之间稍微停一下。
 */
const POST_DELAY_MS =
  Number(
    process.env.SUPERLIKE_RECHECK_POST_DELAY_MS
  )
  || 300;


/*
 * 与 scan-superlike 保持一致：
 *
 * 评论 >= 20
 * → 删除
 */
const MAX_COMMENTS = 20;

/*
 * 轻量评论复检模式：
 * 评论数 > 21 时删除。
 */
const LIGHT_COMMENT_DELETE_THRESHOLD = 21;

const LIGHT_REQUEST_DELAY_MS =
  Number(
    process.env.SUPERLIKE_LIGHT_REQUEST_DELAY_MS
  )
  || 250;

const LIGHT_REQUEST_TIMEOUT_MS =
  Number(
    process.env.SUPERLIKE_LIGHT_REQUEST_TIMEOUT_MS
  )
  || 10000;

const LIGHT_ROUND_INTERVAL_MS =
  Number(
    process.env.SUPERLIKE_LIGHT_ROUND_INTERVAL_MS
  )
  || 3 * 60 * 1000;


/**
 * ============================================================
 * DB
 * ============================================================
 */

function getSuperLikeMonitors() {

  return db.prepare(`
    SELECT
      id,
      name,
      url
    FROM monitors
    WHERE enabled = 1
      AND monitor_type = 'superlike'
    ORDER BY id
  `).all();
}


/**
 * 一个用户可能有很多帖子。
 *
 * Profile 只需要检查一次。
 */
function getDistinctUsers(
  monitorId
) {

  return db.prepare(`
    SELECT
      uid,
      MAX(username) AS username,
      COUNT(*) AS post_count,
      MIN(id) AS first_id
    FROM superlike_posts
    WHERE monitor_id = ?
      AND uid IS NOT NULL
      AND uid <> ''

      -- 只复检最近5天发布的帖子
      AND datetime(first_seen_at) >= datetime('now', '-5 days')

    GROUP BY uid
    ORDER BY first_id ASC
  `).all(
    monitorId
  );
}

/**
 * 获取某个用户当前数据库里的全部候选帖子。
 */
function getPostsByUid(
  monitorId,
  uid
) {

  return db.prepare(`
    SELECT
      post_id,
      uid,
      username,
      post_link,
      comments_count,
      post_created_at
    FROM superlike_posts
    WHERE monitor_id = ?
      AND uid = ?

      -- 只复检最近5天发布的帖子
      AND datetime(first_seen_at) >= datetime('now', '-5 days')

    ORDER BY first_seen_at
  `).all(
    monitorId,
    uid
  );
}

/**
 * 用户已经获得超LIKE：
 *
 * 删除这个 UID 在当前 Monitor 下的所有帖子。
 */
function deleteAllPostsByUid(
  monitorId,
  uid
) {

  const result =
    db.prepare(`
      DELETE FROM superlike_posts
      WHERE monitor_id = ?
        AND uid = ?
    `).run(
      monitorId,
      uid
    );


  return result.changes;
}


/**
 * 评论数已经达到阈值：
 *
 * 只删除当前帖子。
 */
function deleteOnePost(
  monitorId,
  postId
) {

  const result =
    db.prepare(`
      DELETE FROM superlike_posts
      WHERE monitor_id = ?
        AND post_id = ?
    `).run(
      monitorId,
      postId
    );


  return result.changes;
}


/**
 * 评论数仍然 < 20：
 *
 * 更新最新 comments_count。
 */
function updateCommentCount(
  monitorId,
  postId,
  commentsCount
) {

  db.prepare(`
    UPDATE superlike_posts
    SET
      comments_count = ?,
      last_seen_at = CURRENT_TIMESTAMP
    WHERE monitor_id = ?
      AND post_id = ?
  `).run(
    commentsCount,
    monitorId,
    postId
  );
}


/**
 * ============================================================
 * 从 JSON 中递归寻找当前 Post 的 comments_count
 * ============================================================
 */

function findPostCommentsCount(
  value,
  targetPostId,
  visited = new Set()
) {

  if (
    !value
    ||
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


  /*
   * 微博不同接口可能：
   *
   * id
   * idstr
   * mid
   */
  const id =
    value.idstr
    ??
    value.id
    ??
    value.mid;


  if (
    id !== undefined
    &&
    id !== null
    &&
    String(id)
      ===
      String(targetPostId)
  ) {

    const comments =
      value.comments_count
      ??
      value.comment_count;


    if (
      comments !== undefined
      &&
      comments !== null
      &&
      Number.isFinite(
        Number(comments)
      )
    ) {

      return Number(
        comments
      );
    }
  }


  if (
    Array.isArray(value)
  ) {

    for (
      const item
      of value
    ) {

      const result =
        findPostCommentsCount(
          item,
          targetPostId,
          visited
        );


      if (
        result !== null
      ) {
        return result;
      }
    }


    return null;
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

      const result =
        findPostCommentsCount(
          child,
          targetPostId,
          visited
        );


      if (
        result !== null
      ) {
        return result;
      }
    }
  }


  return null;
}


/**
 * ============================================================
 * 打开帖子，读取当前评论数
 *
 * 注意：
 *
 * 这里不判断超LIKE。
 *
 * 超LIKE统一通过 profile_inpage 判断。
 * ============================================================
 */

async function getCurrentCommentsCount(
  page,
  post
) {

  if (
    !post.post_link
  ) {

    return {
      ok: false,
      commentsCount: null,
      message:
        '没有 post_link'
    };
  }


  const capturedJson = [];


  /**
   * 监听打开微博过程中产生的 JSON。
   */
  async function onResponse(
    response
  ) {

    try {

      const url =
        response.url();


      if (
        !url.includes(
          'weibo'
        )
      ) {
        return;
      }


      const contentType =
        response.headers()[
          'content-type'
        ]
        ||
        '';


      if (
        !contentType.includes(
          'json'
        )
      ) {
        return;
      }


      const json =
        await response.json();


      capturedJson.push(
        json
      );


    } catch {
      /*
       * 某些 response 不是有效 JSON。
       *
       * 直接忽略。
       */
    }
  }


  page.on(
    'response',
    onResponse
  );


  try {

    console.log(
      `[Recheck][帖子] 打开 ${post.post_link}`
    );


    await page.goto(
      post.post_link,
      {
        waitUntil:
          'domcontentloaded',

        timeout:
          30000
      }
    );


    await page.waitForTimeout(
      POST_WAIT_MS
    );


    /**
     * ========================================================
     * 第一优先：
     *
     * 从微博页面产生的 JSON Response 中找。
     * ========================================================
     */

    for (
      const json
      of capturedJson
    ) {

      const count =
        findPostCommentsCount(
          json,
          post.post_id
        );


      if (
        count !== null
      ) {

        return {
          ok: true,
          commentsCount:
            count
        };
      }
    }


    /**
     * ========================================================
     * 第二优先：
     *
     * DOM fallback。
     * ========================================================
     */

    const domCount =
      await page.evaluate(
        () => {

          const texts =
            Array.from(
              document.querySelectorAll(
                'a,button,span,div'
              )
            )
              .map(
                element =>
                  (
                    element.textContent
                    ||
                    ''
                  ).trim()
              )
              .filter(Boolean);


          const patterns = [

            /^评论\s*(\d+)$/,

            /^评论\s*\((\d+)\)$/,

            /^评论\s*·?\s*(\d+)$/

          ];


          for (
            const text
            of texts
          ) {

            for (
              const pattern
              of patterns
            ) {

              const match =
                text.match(
                  pattern
                );


              if (
                match
              ) {

                return Number(
                  match[1]
                );
              }
            }
          }


          return null;
        }
      );


    if (
      domCount !== null
    ) {

      return {
        ok: true,
        commentsCount:
          domCount
      };
    }


    return {
      ok: false,
      commentsCount: null,

      message:
        '没有从帖子页面读取到 comments_count'
    };


  } catch (error) {

    return {
      ok: false,
      commentsCount: null,

      message:
        error.message
    };


  } finally {

    page.off(
      'response',
      onResponse
    );
  }
}


/**
 * ============================================================
 * 检查一个 Monitor
 * ============================================================
 */

async function recheckOneMonitor(
  context,
  monitor
) {

  const config =
    parseTopicHomepage(
      monitor.url
    );


  const users =
    getDistinctUsers(
      monitor.id
    );


  console.log('');
  console.log(
    '=============================================='
  );

  console.log(
    `SuperLike Recheck：${monitor.name}`
  );

  console.log(
    `候选用户：${users.length}`
  );

  console.log(
    `Profile Container：${config.profileContainerId}`
  );

  console.log(
    `评论删除阈值：>= ${MAX_COMMENTS}`
  );

  console.log(
    '=============================================='
  );


  /**
   * ==========================================================
   * 注意：
   *
   * 不再创建固定 profilePage。
   *
   * checkUserSuperLikeByProfile(context,...)
   * 内部自己：
   *
   * context.newPage()
   * ↓
   * Profile检查
   * ↓
   * close()
   *
   * visitor 即使关闭当前 tab，
   * 也不会污染下一个 UID。
   * ==========================================================
   */


  /**
   * postPage 仍然长期复用。
   *
   * 它只负责打开帖子检查评论数。
   */
  const postPage =
    await context.newPage();


  const stats = {

    users:
      users.length,

    profileChecked:
      0,

    superLikeUsers:
      0,

    profileFailed:
      0,

    deletedBySuperLike:
      0,

    postsChecked:
      0,

    postFailed:
      0,

    deletedByComments:
      0,

    kept:
      0
  };


  try {

    for (
      let i = 0;
      i < users.length;
      i++
    ) {

      const user =
        users[i];


      const uid =
        String(
          user.uid
        );


      console.log('');
      console.log(
        `========== UID ${i + 1}/${users.length} ==========`
      );

      console.log(
        `UID=${uid}`
      );

      console.log(
        `用户名=${user.username || '-'}`
      );

      console.log(
        `候选帖子=${user.post_count}`
      );


      /**
       * ======================================================
       * STEP 1
       *
       * Profile检查
       * ======================================================
       */

      stats.profileChecked++;


      console.log(
        `[Recheck][Profile] UID=${uid}`
      );


      /*
       * 这里非常重要：
       *
       * 现在传的是 BrowserContext，
       * 不再是 profilePage。
       */
      const profileResult =
        await checkUserSuperLikeByProfile(
          context,
          config,
          uid,
          signal
        );


      /**
       * ======================================================
       * Profile无法确认
       * ======================================================
       */

      if (
        !profileResult.ok
      ) {

        stats.profileFailed++;


        console.log(
          `[Recheck][Profile失败] UID=${uid} | ${
            profileResult.message
            ||
            'unknown'
          }`
        );


        /*
         * 无法确认：
         *
         * 不删除用户
         * 不删除帖子
         *
         * 防止误删。
         */
        continue;
      }


      /**
       * ======================================================
       * STEP 2
       *
       * 已经获得超LIKE
       *
       * 删除该用户全部候选帖子
       * ======================================================
       */

      if (
        profileResult.hasSuperLike
      ) {

        stats.superLikeUsers++;


        const deleted =
          deleteAllPostsByUid(
            monitor.id,
            uid
          );


        stats.deletedBySuperLike +=
          deleted;


        console.log(
          `[Recheck][超LIKE删除] UID=${uid} | 删除 ${deleted} 条`
        );


        /*
         * 不需要检查这个人的帖子评论数了。
         */
        await postPage.waitForTimeout(
          PROFILE_DELAY_MS
        );


        continue;
      }


      console.log(
        `[Recheck][Profile] UID=${uid} 当前没有超LIKE`
      );


      /**
       * ======================================================
       * STEP 3
       *
       * 当前没有超LIKE
       *
       * 检查该用户每一条候选帖子。
       * ======================================================
       */

      const posts =
        getPostsByUid(
          monitor.id,
          uid
        );


      for (
        let p = 0;
        p < posts.length;
        p++
      ) {

        const post =
          posts[p];


        stats.postsChecked++;


        console.log(
          `[Recheck][帖子 ${p + 1}/${posts.length}] Post=${post.post_id}`
        );


        const result =
          await getCurrentCommentsCount(
            postPage,
            post
          );


        /**
         * ====================================================
         * 帖子读取失败
         * ====================================================
         */

        if (
          !result.ok
        ) {

          stats.postFailed++;


          console.log(
            `[Recheck][帖子失败] Post=${post.post_id} | ${
              result.message
              ||
              'unknown'
            }`
          );


          /*
           * 读取失败：
           *
           * 不删除。
           */
          continue;
        }


        const commentsCount =
          Number(
            result.commentsCount
          );


        console.log(
          `[Recheck][评论] Post=${post.post_id} | DB=${post.comments_count} | 当前=${commentsCount}`
        );


        /**
         * ====================================================
         * 评论 >= 20
         *
         * 删除当前帖子。
         * ====================================================
         */

        if (
          commentsCount >=
          MAX_COMMENTS
        ) {

          const deleted =
            deleteOnePost(
              monitor.id,
              post.post_id
            );


          stats.deletedByComments +=
            deleted;


          console.log(
            `[Recheck][评论删除] Post=${post.post_id} | 评论=${commentsCount}`
          );


        } else {

          /**
           * 评论仍然 < 20：
           *
           * 更新数据库。
           */
          updateCommentCount(
            monitor.id,
            post.post_id,
            commentsCount
          );


          stats.kept++;


          console.log(
            `[Recheck][保留] Post=${post.post_id} | 评论=${commentsCount}`
          );
        }


        await postPage.waitForTimeout(
          POST_DELAY_MS
        );
      }


      await postPage.waitForTimeout(
        PROFILE_DELAY_MS
      );
    }


  } finally {

    /*
     * 这里只需要关 postPage。
     *
     * Profile page 已经由
     * checkUserSuperLikeByProfile()
     * 自己负责关闭。
     */
    if (
      postPage
      &&
      !postPage.isClosed()
    ) {

      try {

        await postPage.close();

      } catch {
        // ignore
      }
    }
  }


  /**
   * ==========================================================
   * 最终统计
   * ==========================================================
   */

  console.log('');
  console.log(
    `========== ${monitor.name} Recheck结果 ==========`
  );

  console.log(
    `候选用户：${stats.users}`
  );

  console.log(
    `Profile检查：${stats.profileChecked}`
  );

  console.log(
    `Profile失败：${stats.profileFailed}`
  );

  console.log(
    `发现已有超LIKE用户：${stats.superLikeUsers}`
  );

  console.log(
    `因超LIKE删除帖子：${stats.deletedBySuperLike}`
  );

  console.log(
    `帖子评论复检：${stats.postsChecked}`
  );

  console.log(
    `帖子复检失败：${stats.postFailed}`
  );

  console.log(
    `因评论>=${MAX_COMMENTS}删除：${stats.deletedByComments}`
  );

  console.log(
    `最终保留：${stats.kept}`
  );

  console.log(
    '=============================================='
  );
}


/**
 * ============================================================
 * 轻量评论复检（不启动 Playwright / Chrome）
 * ============================================================
 */
function getAllCandidatePosts() {
  return db.prepare(`
    SELECT
      id,
      monitor_id,
      post_id,
      uid,
      username,
      post_link,
      comments_count
    FROM superlike_posts
    WHERE post_id IS NOT NULL
      AND post_id <> ''
    ORDER BY id DESC
  `).all();
}

function isAbortError(error) {
  return !!error && (
    error.name === 'AbortError'
    || String(error.message || '').toLowerCase().includes('aborted')
  );
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('本轮已被新一轮取消');
    error.name = 'AbortError';
    throw error;
  }
}

function sleep(ms, signal = null) {
  if (!signal) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  if (signal.aborted) {
    return Promise.reject(
      Object.assign(new Error('本轮已被新一轮取消'), { name: 'AbortError' })
    );
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(
        Object.assign(new Error('本轮已被新一轮取消'), { name: 'AbortError' })
      );
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchTextWithTimeout(url, parentSignal = null) {
  const controller = new AbortController();

  const onParentAbort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort();
    } else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  const timer = setTimeout(
    () => controller.abort(),
    LIGHT_REQUEST_TIMEOUT_MS
  );

  try {
    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Referer': 'https://weibo.com/'
    };

    const weiboCookie =
      String(
        process.env.WEIBO_COOKIE
        || ''
      ).trim();

    if (weiboCookie) {
      headers.Cookie =
        weiboCookie;
    }

    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers
    });

    const text = await response.text();

    const lowerText =
      String(text || '').toLowerCase();

    const forbidden =
      response.status === 403
      || lowerText.includes('\"error\":\"forbidden\"')
      || lowerText.includes('forbidden');

    return {
      ok: response.ok && !forbidden,
      status: response.status,
      blocked: response.status === 418,
      forbidden,
      finalUrl: response.url,
      text
    };
  } finally {
    clearTimeout(timer);
    if (parentSignal) {
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }
}

function extractTotalNumberFromText(text) {
  if (!text) {
    return null;
  }

  try {
    const json = JSON.parse(text);

    const value =
      json?.total_number
      ?? json?.data?.total_number;

    if (Number.isFinite(Number(value))) {
      return Number(value);
    }
  } catch {
    // 非 JSON 时继续使用正则兜底。
  }

  const match =
    text.match(/"total_number"\s*:\s*(\d+)/i);

  return match
    ? Number(match[1])
    : null;
}


async function getCommentsCountByHttp(post, signal = null) {
  const postId =
    String(post.post_id || '').trim();

  const uid =
    String(post.uid || '').trim();

  if (!postId) {
    return {
      ok: false,
      commentsCount: null,
      message: '没有 post_id'
    };
  }

  if (!uid) {
    return {
      ok: false,
      commentsCount: null,
      message: '没有 uid'
    };
  }

  /*
   * 轻量模式直接请求 PC 评论接口。
   * total_number 就是当前总评论数。
   */
  const apiUrl =
    new URL(
      'https://weibo.com/ajax/statuses/buildComments'
    );

  apiUrl.searchParams.set('is_reload', '1');
  apiUrl.searchParams.set('id', postId);
  apiUrl.searchParams.set('is_show_bulletin', '3');
  apiUrl.searchParams.set('is_mix', '0');
  apiUrl.searchParams.set('count', '10');
  apiUrl.searchParams.set('uid', uid);
  apiUrl.searchParams.set('fetch_level', '0');
  apiUrl.searchParams.set('locale', 'zh-CN');

  try {
    const apiResult =
      await fetchTextWithTimeout(
        apiUrl.toString(),
        signal
      );

    if (apiResult.blocked) {
      return {
        ok: false,
        blocked: true,
        commentsCount: null,
        status: apiResult.status,
        message: 'HTTP 418'
      };
    }

    if (apiResult.forbidden) {
      return {
        ok: false,
        forbidden: true,
        commentsCount: null,
        status: apiResult.status,
        message:
          'buildComments Forbidden：请检查 WEIBO_COOKIE 是否有效'
      };
    }

    if (!apiResult.ok) {
      return {
        ok: false,
        commentsCount: null,
        status: apiResult.status,
        message:
          `buildComments HTTP ${apiResult.status}`
      };
    }

    const count =
      extractTotalNumberFromText(
        apiResult.text
      );

    if (count === null) {
      return {
        ok: false,
        commentsCount: null,
        status: apiResult.status,
        message:
          'buildComments Response 没有 total_number'
      };
    }

    return {
      ok: true,
      commentsCount: count,
      source: apiUrl.toString()
    };

  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }

    return {
      ok: false,
      commentsCount: null,
      message: isAbortError(error)
        ? '请求超时'
        : error.message
    };
  }
}


/**
 * ============================================================
 * 模式3：轻量 SuperLike Profile 复检
 * 不启动 Playwright / Chrome。
 *
 * 按 Monitor + UID 轮询 profile_inpage：
 * - 命中 SuperLike -> 立即删除该 UID 在当前 Monitor 的全部数据
 * - 未命中 -> 保留
 * - HTTP 418 -> 立即停止本轮，避免继续请求
 * ============================================================
 */
function getDistinctUsersForLightProfile(
  monitorId
) {
  return db.prepare(`
    SELECT
      uid,
      MAX(username) AS username,
      COUNT(*) AS post_count,
      MAX(id) AS latest_id
    FROM superlike_posts
    WHERE monitor_id = ?
      AND uid IS NOT NULL
      AND uid <> ''
    GROUP BY uid
    ORDER BY latest_id DESC
  `).all(
    monitorId
  );
}

function buildLightProfileApiUrl(
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

  // URLSearchParams 会再次编码 %，最终得到 target_uid%2523{uid}
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

function profileTextHasSuperLike(
  text
) {
  if (!text) {
    return false;
  }

  const lower =
    String(text).toLowerCase();

  return (
    lower.includes('fans_title_superlike.png')
    || lower.includes('fans_title_superlike_on.png')
    || lower.includes('chao_like')
    || String(text).includes('超LIKE')
  );
}

async function checkSuperLikeByBrowser(
  context,
  config,
  uid,
  signal = null
) {
  throwIfAborted(signal);

  const apiUrl =
    buildLightProfileApiUrl(
      config,
      uid
    );

  try {
    /*
     * 使用 BrowserContext 关联的 APIRequestContext。
     *
     * 好处：
     * 1. 与当前 BrowserContext 共用 Cookie storage。
     * 2. 不受页面 window.fetch() 的 CORS 限制。
     * 3. 不需要为每个 UID 打开新页面。
     */
    const response =
      await context.request.get(
        apiUrl,
        {
          headers: {
            'Accept':
              'application/json, text/plain, */*',

            'Referer':
              'https://m.weibo.cn/'
          },

          timeout:
            LIGHT_REQUEST_TIMEOUT_MS
        }
      );

    throwIfAborted(signal);

    const status =
      response.status();

    const body =
      await response.text();

    if (
      status === 418
    ) {
      return {
        ok: false,
        blocked: true,
        hasSuperLike: null,
        status,
        url: apiUrl,
        message:
          'profile_inpage HTTP 418'
      };
    }

    if (
      status < 200
      ||
      status >= 300
    ) {
      return {
        ok: false,
        blocked: false,
        hasSuperLike: null,
        status,
        url: apiUrl,
        message:
          `profile_inpage HTTP ${status} | ${body.slice(0, 500)}`
      };
    }

    let json =
      null;

    try {
      json =
        JSON.parse(
          body
        );
    } catch {
      return {
        ok: false,
        blocked: false,
        hasSuperLike: null,
        status,
        url: apiUrl,
        message:
          `profile_inpage 返回的不是 JSON | ${body.slice(0, 500)}`
      };
    }

    if (
      Number(
        json?.ok
        ??
        0
      ) !== 1
    ) {
      return {
        ok: false,
        blocked: false,
        hasSuperLike: null,
        status,
        url: apiUrl,
        message:
          `profile_inpage API ok=${json?.ok} | ${body.slice(0, 500)}`
      };
    }

    return {
      ok: true,
      blocked: false,
      hasSuperLike:
        profileTextHasSuperLike(
          body
        ),
      status,
      url: apiUrl
    };

  } catch (error) {
    if (
      signal?.aborted
      ||
      isAbortError(error)
    ) {
      const abortError =
        new Error(
          '本轮已被新一轮取消'
        );

      abortError.name =
        'AbortError';

      throw abortError;
    }

    return {
      ok: false,
      blocked: false,
      hasSuperLike: null,
      status: null,
      url: apiUrl,
      message:
        error.message
    };
  }
}

async function runLightSuperLikeRecheck(signal = null) {
  const monitors =
    getSuperLikeMonitors();

  const stats = {
    monitors: monitors.length,
    users: 0,
    checked: 0,
    hasSuperLike: 0,
    deletedRows: 0,
    failed: 0
  };

  console.log('');
  console.log('########################################');
  console.log('# SuperLike Recheck - 模式3 BrowserContext Profile 模式');
  console.log('# 复用 superlike-scanner 的 checkUserSuperLikeByProfile');
  console.log('# headless，不显示 Chrome 窗口');
  console.log('# 发现 SuperLike -> 立即删除该 UID 全部数据');
  console.log('# 数据库顺序：按 UID 的 MAX(id) DESC');
  console.log('########################################');

  let context = null;

  const onAbort = () => {
    if (context) {
      context.close().catch(() => {});
    }
  };

  if (signal) {
    signal.addEventListener(
      'abort',
      onAbort,
      { once: true }
    );
  }

  try {
    throwIfAborted(signal);

    const { chromium } =
      require('playwright');

    /*
     * 使用和 SuperLike 扫描一致的持久化 Profile。
     * 这样可以复用已经建立好的微博 visitor/session。
     */
    const profileDir =
      path.join(
        __dirname,
        '..',
        'data',
        'superlike-browser-profile-scan'
      );

    context =
      await chromium.launchPersistentContext(
        profileDir,
        {
          headless: true,
          viewport: {
            width: 1280,
            height: 900
          }
        }
      );

    outer:
    for (
      const monitor
      of monitors
    ) {
      throwIfAborted(signal);

      const config =
        parseTopicHomepage(
          monitor.url
        );

      const users =
        getDistinctUsersForLightProfile(
          monitor.id
        );

      stats.users +=
        users.length;

      console.log('');
      console.log(
        `[轻量Profile] Monitor=${monitor.name} | UID=${users.length}`
      );

      for (
        let i = 0;
        i < users.length;
        i++
      ) {
        throwIfAborted(signal);

        const user =
          users[i];

        const uid =
          String(
            user.uid
            ||
            ''
          ).trim();

        let result;

        try {
          result =
            await checkUserSuperLikeByProfile(
              context,
              config,
              uid
            );

        } catch (error) {
          if (
            signal?.aborted
            ||
            isAbortError(error)
            ||
            /Target page, context or browser has been closed/i.test(
              String(error.message || '')
            )
          ) {
            const abortError =
              new Error('本轮已被新一轮取消');

            abortError.name =
              'AbortError';

            throw abortError;
          }

          result = {
            ok: false,
            hasSuperLike: null,
            message: error.message
          };
        }

        throwIfAborted(signal);

        if (
          !result
          ||
          !result.ok
        ) {
          stats.failed++;

          console.log(
            `[轻量Profile ${i + 1}/${users.length}] ` +
            `UID=${uid} | 失败 | ${
              result?.message
              ||
              'unknown'
            }`
          );

          await sleep(
            LIGHT_REQUEST_DELAY_MS,
            signal
          );

          continue;
        }

        stats.checked++;

        if (
          result.hasSuperLike
        ) {
          stats.hasSuperLike++;

          const deleted =
            deleteAllPostsByUid(
              monitor.id,
              uid
            );

          stats.deletedRows +=
            deleted;

          console.log(
            `[轻量Profile ${i + 1}/${users.length}] ` +
            `UID=${uid} | SuperLike=是 | 立即删除 ${deleted} 条`
          );

        } else {
          console.log(
            `[轻量Profile ${i + 1}/${users.length}] ` +
            `UID=${uid} | SuperLike=否 | 保留`
          );
        }

        await sleep(
          LIGHT_REQUEST_DELAY_MS,
          signal
        );
      }
    }

  } finally {
    if (
      signal
    ) {
      signal.removeEventListener(
        'abort',
        onAbort
      );
    }

    if (
      context
    ) {
      try {
        await context.close();
      } catch {
        // ignore
      }
    }

    console.log('');
    console.log('========== 模式3 Profile 复检完成 ==========');
    console.log(`Monitor：${stats.monitors}`);
    console.log(`数据库UID：${stats.users}`);
    console.log(`成功检查：${stats.checked}`);
    console.log(`发现SuperLike：${stats.hasSuperLike}`);
    console.log(`删除记录：${stats.deletedRows}`);
    console.log(`失败：${stats.failed}`);
    console.log('===========================================');
  }
}

async function getCommentsCountFromDomOnly(
  page,
  post,
  signal = null
) {
  throwIfAborted(signal);

  if (!post.post_link) {
    return {
      ok: false,
      commentsCount: null,
      message: '没有 post_link'
    };
  }

  const postId =
    String(
      post.post_id
      ||
      ''
    ).trim();

  const uid =
    String(
      post.uid
      ||
      ''
    ).trim();

  if (!postId || !uid) {
    return {
      ok: false,
      commentsCount: null,
      message:
        '缺少 post_id 或 uid'
    };
  }

  try {
    console.log(
      `[轻量浏览器] 打开 ${post.post_link}`
    );

    const response =
      await page.goto(
        post.post_link,
        {
          waitUntil:
            'domcontentloaded',
          timeout:
            30000
        }
      );

    throwIfAborted(signal);

    if (
      response
      &&
      response.status() === 418
    ) {
      return {
        ok: false,
        blocked: true,
        commentsCount: null,
        message: '帖子页面 HTTP 418'
      };
    }

    /*
     * 给微博页面一点时间建立前端会话环境。
     */
    await page.waitForTimeout(
      800
    );

    throwIfAborted(signal);

    /*
     * 关键：
     *
     * 不再从 Node.js 裸 fetch buildComments。
     *
     * 而是在已经打开的 weibo.com 帖子页面上下文里，
     * 直接执行 window.fetch()。
     *
     * credentials:'include'
     * 会自动携带当前浏览器上下文 Cookie。
     */
    const apiResult =
      await page.evaluate(
        async ({
          postId,
          uid
        }) => {

          const url =
            new URL(
              '/ajax/statuses/buildComments',
              window.location.origin
            );

          url.searchParams.set(
            'is_reload',
            '1'
          );

          url.searchParams.set(
            'id',
            postId
          );

          url.searchParams.set(
            'is_show_bulletin',
            '3'
          );

          url.searchParams.set(
            'is_mix',
            '0'
          );

          url.searchParams.set(
            'count',
            '10'
          );

          url.searchParams.set(
            'uid',
            uid
          );

          url.searchParams.set(
            'fetch_level',
            '0'
          );

          url.searchParams.set(
            'locale',
            'zh-CN'
          );

          try {
            const response =
              await fetch(
                url.toString(),
                {
                  method:
                    'GET',

                  credentials:
                    'include',

                  headers: {
                    'Accept':
                      'application/json, text/plain, */*'
                  }
                }
              );

            const text =
              await response.text();

            let json =
              null;

            try {
              json =
                JSON.parse(
                  text
                );
            } catch {
              // 非 JSON，保留 text 供日志诊断。
            }

            return {
              ok:
                response.ok,

              status:
                response.status,

              url:
                response.url,

              text:
                text.slice(
                  0,
                  1000
                ),

              json
            };

          } catch (error) {
            return {
              ok: false,
              status: 0,
              url:
                url.toString(),
              text: '',
              json: null,
              error:
                error.message
            };
          }
        },
        {
          postId,
          uid
        }
      );

    throwIfAborted(signal);

    if (
      apiResult.status === 418
    ) {
      return {
        ok: false,
        blocked: true,
        commentsCount: null,
        message:
          'buildComments HTTP 418'
      };
    }

    if (
      apiResult.status === 403
      ||
      /Forbidden/i.test(
        String(
          apiResult.text
          ||
          ''
        )
      )
    ) {
      return {
        ok: false,
        commentsCount: null,
        message:
          `buildComments Forbidden (status=${apiResult.status}) | ${apiResult.text}`
      };
    }

    if (
      !apiResult.ok
    ) {
      return {
        ok: false,
        commentsCount: null,
        message:
          `buildComments HTTP ${apiResult.status} | ${apiResult.text || apiResult.error || ''}`
      };
    }

    const totalNumber =
      apiResult.json?.total_number
      ??
      apiResult.json?.data?.total_number
      ??
      null;

    if (
      Number.isFinite(
        Number(
          totalNumber
        )
      )
    ) {
      return {
        ok: true,
        commentsCount:
          Number(
            totalNumber
          )
      };
    }

    console.log(
      `[轻量浏览器][buildComments响应] Post=${postId} | status=${apiResult.status} | body=${apiResult.text}`
    );

    return {
      ok: false,
      commentsCount: null,
      message:
        'buildComments Response 没有 total_number'
    };

  } catch (error) {
    if (
      signal?.aborted
      ||
      isAbortError(error)
      ||
      /Target page, context or browser has been closed/i.test(
        String(
          error.message
          ||
          ''
        )
      )
    ) {
      const abortError =
        new Error(
          '本轮已被新一轮取消'
        );

      abortError.name =
        'AbortError';

      throw abortError;
    }

    return {
      ok: false,
      commentsCount: null,
      message:
        error.message
    };
  }
}

async function runLightCommentRecheck(signal = null) {
  const posts =
    getAllCandidatePosts();

  const stats = {
    total: posts.length,
    checked: 0,
    updated: 0,
    deleted: 0,
    failed: 0,
    blocked418: false
  };

  console.log('');
  console.log('########################################');
  console.log('# SuperLike Recheck - 模式2 浏览器AJAX评论复检');
  console.log('# 单个 headless Chromium + 单个 Page + 页面内 buildComments fetch');
  console.log(`# 评论 > ${LIGHT_COMMENT_DELETE_THRESHOLD} → 删除帖子`);
  console.log('# 其余 → 只更新 comments_count');
  console.log('# 数据库顺序：id DESC');
  console.log(`读取帖子数：${posts.length}`);
  console.log('########################################');

  let context = null;
  let page = null;

  const onAbort = () => {
    if (context) {
      context.close().catch(() => {});
    }
  };

  if (signal) {
    signal.addEventListener(
      'abort',
      onAbort,
      { once: true }
    );
  }

  try {
    throwIfAborted(signal);

    const { chromium } =
      require('playwright');

    const profileDir =
      path.join(
        __dirname,
        '..',
        'data',
        'superlike-browser-profile-recheck-light'
      );

    context =
      await chromium.launchPersistentContext(
        profileDir,
        {
          headless: true,
          viewport: {
            width: 1280,
            height: 900
          }
        }
      );

    throwIfAborted(signal);

    page =
      context.pages()[0]
      || await context.newPage();

    for (
      let i = 0;
      i < posts.length;
      i++
    ) {
      throwIfAborted(signal);

      const post = posts[i];

      const result =
        await getCommentsCountFromDomOnly(
          page,
          post,
          signal
        );

      if (!result.ok) {
        stats.failed++;

        if (result.blocked) {
          stats.blocked418 = true;

          console.log(
            `[轻量浏览器 ${i + 1}/${posts.length}] ` +
            `ID=${post.id} | Post=${post.post_id} | HTTP 418，本轮停止`
          );

          break;
        }

        console.log(
          `[轻量浏览器 ${i + 1}/${posts.length}] ` +
          `ID=${post.id} | Post=${post.post_id} | 失败 | ${result.message || 'unknown'}`
        );

        await sleep(
          LIGHT_REQUEST_DELAY_MS,
          signal
        );
        continue;
      }

      stats.checked++;

      throwIfAborted(signal);

      const commentsCount =
        Number(result.commentsCount);

      if (
        commentsCount >
        LIGHT_COMMENT_DELETE_THRESHOLD
      ) {
        const deleted =
          deleteOnePost(
            post.monitor_id,
            post.post_id
          );

        stats.deleted += deleted;

        console.log(
          `[轻量浏览器 ${i + 1}/${posts.length}] ` +
          `ID=${post.id} | Post=${post.post_id} | 评论=${commentsCount} | 删除`
        );

      } else {
        updateCommentCount(
          post.monitor_id,
          post.post_id,
          commentsCount
        );

        stats.updated++;

        console.log(
          `[轻量浏览器 ${i + 1}/${posts.length}] ` +
          `ID=${post.id} | Post=${post.post_id} | 评论=${commentsCount} | 更新保留`
        );
      }

      await sleep(
        LIGHT_REQUEST_DELAY_MS,
        signal
      );
    }

  } finally {
    if (signal) {
      signal.removeEventListener(
        'abort',
        onAbort
      );
    }

    if (context) {
      try {
        await context.close();
      } catch {
        // ignore
      }
    }
  }

  console.log('');
  console.log('========== 模式2 DOM评论复检完成 ==========');
  console.log(`总帖子：${stats.total}`);
  console.log(`成功读取：${stats.checked}`);
  console.log(`更新：${stats.updated}`);
  console.log(`删除：${stats.deleted}`);
  console.log(`失败：${stats.failed}`);
  console.log(`HTTP 418中止：${stats.blocked418 ? '是' : '否'}`);
  console.log('==========================================');
}


/**
 * ============================================================
 * 模式2/3常驻轮询
 *
 * - 每3分钟从“本轮开始时间”计时
 * - 到点时如果上一轮还没结束：先 abort 上一轮，再开启新一轮
 * - 如果上一轮提前结束：等待到3分钟边界再开始下一轮
 * ============================================================
 */
async function runLightModeForever(mode) {
  let round = 0;

  console.log('');
  console.log(
    `[Recheck] 模式${mode} 已进入常驻轮询：每 ${LIGHT_ROUND_INTERVAL_MS / 60000} 分钟强制开启新一轮。`
  );

  while (true) {
    round++;

    console.log('');
    console.log(
      `[Recheck] ===== 模式${mode} 第${round}轮开始 =====`
    );

    const controller =
      new AbortController();

    const startedAt =
      Date.now();

    const roundPromise =
      (
        mode === '2'
          ? runLightCommentRecheck(controller.signal)
          : runLightSuperLikeRecheck(controller.signal)
      )
        .then(() => ({ type: 'done' }))
        .catch(error => ({ type: 'error', error }));

    const timerPromise =
      new Promise(resolve => {
        const remain =
          Math.max(
            0,
            LIGHT_ROUND_INTERVAL_MS
              - (Date.now() - startedAt)
          );

        setTimeout(
          () => resolve({ type: 'timer' }),
          remain
        );
      });

    const first =
      await Promise.race([
        roundPromise,
        timerPromise
      ]);

    if (first.type === 'timer') {
      console.log(
        `[Recheck] ${LIGHT_ROUND_INTERVAL_MS / 60000}分钟到：取消模式${mode}第${round}轮，立即开启下一轮。`
      );

      controller.abort();

      const ended =
        await roundPromise;

      if (
        ended.type === 'error'
        &&
        !isAbortError(ended.error)
      ) {
        console.error(
          `[Recheck] 模式${mode} 第${round}轮异常：`,
          ended.error
        );
      } else {
        console.log(
          `[Recheck] 模式${mode} 第${round}轮已被下一轮取消。`
        );
      }

      continue;
    }

    if (
      first.type === 'error'
      &&
      !isAbortError(first.error)
    ) {
      console.error(
        `[Recheck] 模式${mode} 第${round}轮异常：`,
        first.error
      );
    }

    const elapsed =
      Date.now() - startedAt;

    const waitMs =
      Math.max(
        0,
        LIGHT_ROUND_INTERVAL_MS - elapsed
      );

    if (waitMs > 0) {
      console.log(
        `[Recheck] 模式${mode} 第${round}轮已结束，等待下一次3分钟边界。`
      );

      await sleep(waitMs);
    }
  }
}

function askRecheckMode() {
  if (
    process.env.SUPERLIKE_RECHECK_MODE === '1'
    || process.env.SUPERLIKE_RECHECK_MODE === '2'
    || process.env.SUPERLIKE_RECHECK_MODE === '3'
  ) {
    return Promise.resolve(
      process.env.SUPERLIKE_RECHECK_MODE
    );
  }

  return new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    console.log('');
    console.log('请选择 Recheck 模式：');
    console.log('1 = 原来的完整逻辑（SuperLike + 评论检查）');
    console.log('2 = 轻量评论逻辑（每3分钟一轮，DB id从大到小，评论 > 21 删除）');
    console.log('3 = SuperLike复检逻辑（每3分钟一轮，按最新DB id从大到小，复用scanner的Profile检查，有SuperLike立即删除）');

    rl.question('请输入 1、2 或 3：', answer => {
      rl.close();

      const mode =
        String(answer || '').trim();

      resolve(
        mode === '2' || mode === '3'
          ? mode
          : '1'
      );
    });
  });
}

/**
 * ============================================================
 * MAIN
 * ============================================================
 */

async function main() {

  initDatabase();


  const mode =
    await askRecheckMode();


  if (mode === '2' || mode === '3') {
    await runLightModeForever(mode);
    return;
  }


  // 模式2/3都已在上面 return；只有模式1才加载 Playwright。
  const { chromium } = require('playwright');


  const monitors =
    getSuperLikeMonitors();


  if (
    monitors.length === 0
  ) {

    console.log(
      '[Recheck] 没有启用的 SuperLike Monitor。'
    );


    return;
  }


  /**
   * 和 scan-superlike 使用同一个 Persistent Profile。
   *
   * visitor cookie / 微博 session 可以保留下来。
   */
  const profileDir =
    path.join(
      __dirname,
      '..',
      'data',
      'superlike-browser-profile-recheck'
    );


  let context = null;


  try {

    context =
      await chromium.launchPersistentContext(
        profileDir,
        {

          /*
           * 现在先保持浏览器窗口。
           *
           * 后面稳定以后再改 headless。
           */
          headless:
            false,

          viewport: {
            width:
              1280,

            height:
              900
          }
        }
      );


    console.log('');
    console.log(
      '########################################'
    );

    console.log(
      '# SuperLike Recheck Batch'
    );

    console.log(
      '# 手动执行一次'
    );

    console.log(
      '# 有超LIKE → 删除该UID全部帖子'
    );

    console.log(
      `# 评论>=${MAX_COMMENTS} → 删除当前帖子`
    );

    console.log(
      '# Profile/帖子检查失败 → 不删除'
    );

    console.log(
      '########################################'
    );


    for (
      const monitor
      of monitors
    ) {

      await recheckOneMonitor(
        context,
        monitor
      );
    }


  } finally {

    if (
      context
    ) {

      try {

        await context.close();

      } catch {
        // ignore
      }
    }
  }


  console.log('');
  console.log(
    '[Recheck] 全部完成。'
  );
}


/**
 * ============================================================
 * START
 * ============================================================
 */

main()
  .catch(
    error => {

      console.error(
        '[Recheck] 执行失败：',
        error
      );


      process.exit(1);
    }
  );