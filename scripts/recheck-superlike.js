const path = require('path');

const {
  chromium
} = require('playwright');

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
      comments_count
    FROM superlike_posts
    WHERE monitor_id = ?
      AND uid = ?
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
          uid
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
 * MAIN
 * ============================================================
 */

async function main() {

  initDatabase();


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