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


const POST_WAIT_MS =
  Number(
    process.env.SUPERLIKE_RECHECK_POST_WAIT_MS
  )
  || 2500;


const PROFILE_DELAY_MS =
  Number(
    process.env.SUPERLIKE_RECHECK_PROFILE_DELAY_MS
  )
  || 300;


const POST_DELAY_MS =
  Number(
    process.env.SUPERLIKE_RECHECK_POST_DELAY_MS
  )
  || 300;


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


function getDistinctUsers(
  monitorId
) {

  return db.prepare(`
    SELECT
      uid,
      MAX(username) AS username,
      COUNT(*) AS post_count
    FROM superlike_posts
    WHERE monitor_id = ?
      AND uid IS NOT NULL
      AND uid <> ''
    GROUP BY uid
    ORDER BY uid
  `).all(
    monitorId
  );
}


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
 * 递归找 comments_count
 *
 * 打开帖子页面以后，微博前端通常会再请求 JSON。
 * 我们监听这些 response，只要里面找到当前 post_id，
 * 就拿它的 comments_count。
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
    String(id) ===
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
 * 打开帖子，读取最新评论数
 *
 * 不用这里判断超LIKE。
 *
 * 因为我们已经知道：
 * 单条帖子详情 response 的 user 没有完整 icons。
 *
 * 这里只负责：
 *
 * comments_count
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
      message: '没有 post_link'
    };
  }


  const capturedJson = [];


  async function onResponse(
    response
  ) {

    const url =
      response.url();


    if (
      !url.includes('weibo')
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


    try {

      const json =
        await response.json();


      capturedJson.push(
        json
      );

    } catch {
      // ignore
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


    /*
     * 优先从页面产生的 JSON response 找。
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


    /*
     * DOM fallback。
     *
     * 微博页面可能直接显示：
     *
     * 评论
     * 评论 15
     * 评论(15)
     *
     * 这里只作为第二选择。
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
              el =>
                (
                  el.textContent
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
 * 一个 Monitor
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
    `Profile：${config.profileContainerId}`
  );

  console.log(
    '=============================================='
  );


  const profilePage =
    await context.newPage();


  const postPage =
    await context.newPage();


  const stats = {

    users:
      users.length,

    profileChecked: 0,

    superLikeUsers: 0,

    profileFailed: 0,

    deletedBySuperLike: 0,

    postsChecked: 0,

    postFailed: 0,

    deletedByComments: 0,

    kept: 0
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
       * ==========================================
       * 1. 用户 Profile
       * ==========================================
       */

      stats.profileChecked++;


      console.log(
        `[Recheck][Profile] UID=${uid}`
      );


      const profileResult =
        await checkUserSuperLikeByProfile(
          profilePage,
          config,
          uid
        );


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
         * Profile 都确认不了时，
         * 不删除这个用户。
         *
         * 也暂时不继续删除帖子，
         * 避免错误处理。
         */
        continue;
      }


      /**
       * ==========================================
       * 2. 已经有超LIKE
       *
       * 删除这个 UID 全部候选
       * ==========================================
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


        await profilePage.waitForTimeout(
          PROFILE_DELAY_MS
        );


        continue;
      }


      console.log(
        `[Recheck][Profile] UID=${uid} 当前没有超LIKE`
      );


      /**
       * ==========================================
       * 3. 没有超LIKE
       *
       * 检查这个用户的每条帖子
       * ==========================================
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


        const result =
          await getCurrentCommentsCount(
            postPage,
            post
          );


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


          continue;
        }


        const commentsCount =
          result.commentsCount;


        console.log(
          `[Recheck][评论] Post=${post.post_id} | 当前=${commentsCount}`
        );


        /**
         * 更新数据库里的最新评论数
         */
        updateCommentCount(
          monitor.id,
          post.post_id,
          commentsCount
        );


        /**
         * 用户说的是：
         *
         * 大于二十条评论删除当前那条
         *
         * 这里按：
         *
         * > 20
         *
         * 如果你希望“20也删”，改成 >= 20。
         */
        if (
          commentsCount > 20
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

          stats.kept++;


          console.log(
            `[Recheck][保留] Post=${post.post_id} | 评论=${commentsCount}`
          );
        }


        await postPage.waitForTimeout(
          POST_DELAY_MS
        );
      }


      await profilePage.waitForTimeout(
        PROFILE_DELAY_MS
      );
    }


  } finally {

    try {
      await profilePage.close();
    } catch {
      // ignore
    }


    try {
      await postPage.close();
    } catch {
      // ignore
    }
  }


  console.log('');
  console.log(
    `========== ${monitor.name} Recheck结果 ==========`
  );

  console.log(
    `用户数：${stats.users}`
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
    `因评论>20删除：${stats.deletedByComments}`
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
 * Main
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


  const profileDir =
    path.join(
      __dirname,
      '..',
      'data',
      'superlike-browser-profile'
    );


  let context;


  try {

    context =
      await chromium.launchPersistentContext(
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