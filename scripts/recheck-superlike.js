const {
  createBatchLogger
} = require('../src/batch-logger');


let batchLogger = null;
  
const path = require('path');
const {
  ProxyPool
} = require('../src/proxy-pool');

function getPlaywrightProxyConfig(rawValue) {
  const raw = String(rawValue || '').trim();

  if (!raw) {
    return null;
  }

  try {
    const parsed = new URL(raw);

    const server =
      `${parsed.protocol}//${parsed.hostname}${parsed.port ? ':' + parsed.port : ''}`;

    const proxy = { server };

    if (parsed.username) {
      proxy.username = decodeURIComponent(parsed.username);
    }

    if (parsed.password) {
      proxy.password = decodeURIComponent(parsed.password);
    }

    return proxy;
  } catch {
    return {
      server: raw
    };
  }
}

const MODE2_PROXY_POOL =
  new ProxyPool({
    /*
     * Mode2 与 Scan 共用 weibo-good-proxies.txt，
     * 只消费已经通过微博实测的健康代理。
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
      process.env.SUPERLIKE_MODE2_PROXY_POOL
      || '',

    fallback:
      process.env.SUPERLIKE_MODE2_PROXY
      || process.env.WEIBO_PROXY
      || '',

    cooldownMs:
      Number(
        process.env.SUPERLIKE_PROXY_COOLDOWN_MS
      )
      || 30 * 60 * 1000,

    name:
      'mode2'
  });

const MODE1_PROXY_POOL =
  new ProxyPool({
    filePath:
      process.env.WEIBO_GOOD_PROXY_FILE
      || path.join(
        __dirname,
        '..',
        'data',
        'weibo-good-proxies.txt'
      ),

    dynamicSource: '',

    rawPool:
      process.env.SUPERLIKE_MODE1_PROXY_POOL
      || '',

    fallback:
      process.env.SUPERLIKE_RECHECK_PROXY
      || process.env.WEIBO_PROXY
      || '',

    cooldownMs:
      Number(
        process.env.SUPERLIKE_PROXY_COOLDOWN_MS
      )
      || 30 * 60 * 1000,

    name:
      'mode1'
  });

const MODE3_PROXY_POOL =
  new ProxyPool({
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
      process.env.SUPERLIKE_MODE3_PROXY_POOL
      || '',

    fallback:
      process.env.SUPERLIKE_MODE3_PROXY
      || '',

    cooldownMs:
      Number(
        process.env.SUPERLIKE_PROXY_COOLDOWN_MS
      )
      || 30 * 60 * 1000,

    name:
      'mode3'
  });

function getModeProxyConfig(mode) {
  /*
   * 默认分流策略：
   *
   * Mode2：允许使用专用代理；未设置时可回退到 WEIBO_PROXY。
   * Mode3：默认本地 IP。只有显式设置 SUPERLIKE_MODE3_PROXY 才走代理。
   * Mode4：默认本地 IP。只有显式设置 SUPERLIKE_MODE4_PROXY 才走代理，
   *        避免影响 Persistent Profile / 登录状态。
   * Mode1：保持原来的可选代理逻辑。
   */
  let rawValue = '';

  if (mode === '2') {
    rawValue =
      process.env.SUPERLIKE_MODE2_PROXY
      || process.env.WEIBO_PROXY
      || '';
  } else if (mode === '3') {
    rawValue =
      process.env.SUPERLIKE_MODE3_PROXY
      || '';
  } else if (mode === '4') {
    rawValue =
      process.env.SUPERLIKE_MODE4_PROXY
      || '';
  } else {
    rawValue =
      process.env.SUPERLIKE_RECHECK_PROXY
      || process.env.WEIBO_PROXY
      || '';
  }

  return getPlaywrightProxyConfig(
    rawValue
  );
}

const readline = require('readline');

const {
  db,
  initDatabase,
  saveSuperLikeUser
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
 * 评论 >= 21
 * → 删除
 */
const MAX_COMMENTS = 21;

/*
 * 轻量评论复检模式：
 * 评论数 >= 21 时删除。
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

const MODE2_ROUND_INTERVAL_MS =
  Number(
    process.env.SUPERLIKE_MODE2_ROUND_INTERVAL_MS
  )
  || 30 * 1000;

const MODE3_ROUND_INTERVAL_MS =
  Number(
    process.env.SUPERLIKE_MODE3_ROUND_INTERVAL_MS
  )
  || 2 * 60 * 1000;

/*
 * Mode2：
 * 每30秒检查一次“已到期”的帖子。
 * 每轮最多80条，并优先 comments_count 高的。
 */
const COMMENT_HOT_BATCH_SIZE =
  Number(process.env.SUPERLIKE_COMMENT_HOT_BATCH_SIZE)
  || 60;

/*
 * Mode3 Profile：
 * 00:00-18:59 每2分钟一轮，每轮最多30个 UID。
 * 按“最久未检查”顺序循环覆盖 superlike_posts 中全部候选 UID。
 * 19:00 后暂停，Mode4 优先。
 */
const PROFILE_VERIFY_BATCH_SIZE =
  Number(process.env.SUPERLIKE_PROFILE_VERIFY_BATCH_SIZE)
  || 30;


const LIST_FIRST_RUN_MAX_PAGES =
  Number(
    process.env.SUPERLIKE_LIST_FIRST_RUN_MAX_PAGES
  )
  || 50;

const LIST_DAY_INTERVAL_MS =
  Number(
    process.env.SUPERLIKE_LIST_DAY_INTERVAL_MS
  )
  || 20 * 60 * 1000;

const LIST_NIGHT_INTERVAL_MS =
  Number(
    process.env.SUPERLIKE_LIST_NIGHT_INTERVAL_MS
  )
  || 5 * 60 * 1000;

const LIST_NIGHT_START_HOUR =
  Number(
    process.env.SUPERLIKE_LIST_NIGHT_START_HOUR
  )
  || 19;

const LIST_REQUEST_DELAY_MS =
  Number(
    process.env.SUPERLIKE_LIST_REQUEST_DELAY_MS
  )
  || 250;


const LIST_DELTA_SAFETY_PAGES =
  Number(
    process.env.SUPERLIKE_LIST_DELTA_SAFETY_PAGES
  )
  || 30;


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


function initSuperLikeListStateTable() {
  initDatabase();
}

function getSuperLikeListState(
  monitorId
) {
  initSuperLikeListStateTable();

  const row =
    db.prepare(`
      SELECT
        last_uid,
        scan_date,
        last_total,
        updated_at
      FROM superlike_list_state
      WHERE monitor_id = ?
    `).get(
      monitorId
    );

  return row
    ? {
        lastUid:
          row.last_uid
            ? String(row.last_uid)
            : null,

        scanDate:
          row.scan_date
            ? String(row.scan_date)
            : null,

        lastTotal:
          Number.isFinite(
            Number(row.last_total)
          )
            ? Number(row.last_total)
            : null,

        updatedAt:
          row.updated_at
          || null
      }
    : null;
}

function saveSuperLikeListState(
  monitorId,
  lastUid,
  scanDate,
  lastTotal
) {
  if (!lastUid) {
    return;
  }

  initSuperLikeListStateTable();

  db.prepare(`
    INSERT INTO superlike_list_state(
      monitor_id,
      last_uid,
      scan_date,
      last_total,
      updated_at
    )
    VALUES(?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(monitor_id) DO UPDATE SET
      last_uid = excluded.last_uid,
      scan_date = excluded.scan_date,
      last_total = excluded.last_total,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    monitorId,
    String(lastUid),
    scanDate || null,
    Number.isFinite(
      Number(lastTotal)
    )
      ? Number(lastTotal)
      : null
  );
}

function getWeiboScanDate() {
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
    ).formatToParts(
      new Date()
    );

  const map = {};

  for (
    const part
    of parts
  ) {
    map[part.type] =
      part.value;
  }

  return `${map.year}-${map.month}-${map.day}`;
}

function getChinaDateTime() {
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
          '2-digit',
        hour:
          '2-digit',
        minute:
          '2-digit',
        second:
          '2-digit',
        hour12:
          false
      }
    ).formatToParts(
      new Date()
    );

  const map = {};

  for (
    const part
    of parts
  ) {
    map[part.type] =
      part.value;
  }

  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}


function parseSuperLikeTotalText(
  value
) {
  if (!value) {
    return null;
  }

  const text =
    String(value);

  const wanMatch =
    text.match(
      /超\s*LIKE\s*\(\s*([\d.]+)\s*万\s*人?\s*\)/i
    );

  if (wanMatch) {
    const number =
      Number(
        wanMatch[1]
      );

    return Number.isFinite(number)
      ? Math.round(
          number * 10000
        )
      : null;
  }

  const plainMatch =
    text.match(
      /超\s*LIKE\s*\(\s*([\d,]+)\s*人?\s*\)/i
    );

  if (plainMatch) {
    const number =
      Number(
        plainMatch[1]
          .replace(/,/g, '')
      );

    return Number.isFinite(number)
      ? number
      : null;
  }

  return null;
}

function extractSuperLikeTotal(
  json
) {
  const visited =
    new Set();

  function walk(value) {
    if (
      value === null
      ||
      value === undefined
    ) {
      return null;
    }

    if (
      typeof value === 'string'
    ) {
      return parseSuperLikeTotalText(
        value
      );
    }

    if (
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
      typeof value.desc === 'string'
    ) {
      const parsed =
        parseSuperLikeTotalText(
          value.desc
        );

      if (parsed !== null) {
        return parsed;
      }
    }

    if (Array.isArray(value)) {
      for (
        const item
        of value
      ) {
        const result =
          walk(item);

        if (result !== null) {
          return result;
        }
      }

      return null;
    }

    for (
      const child
      of Object.values(value)
    ) {
      const result =
        walk(child);

      if (result !== null) {
        return result;
      }
    }

    return null;
  }

  return walk(json);
}

function calculateListMaxPages(
  currentTotal,
  previousTotal
) {
  if (
    !Number.isFinite(
      Number(currentTotal)
    )
    ||
    !Number.isFinite(
      Number(previousTotal)
    )
  ) {
    return null;
  }

  const delta =
    Math.max(
      0,
      Number(currentTotal)
        - Number(previousTotal)
    );

  /*
   * 白天人数不变时不要再白扫 30 页。
   * 增量越小，保险页越小；真正爆量时再恢复 delta/20 + 30。
   */
  if (delta === 0) return 5;
  if (delta <= 100) return Math.ceil(delta / 20) + 10;
  if (delta <= 500) return Math.ceil(delta / 20) + 20;

  return Math.ceil(delta / 20)
    + LIST_DELTA_SAFETY_PAGES;
}





function initSuperLikeUsersTable() {
  initDatabase();
}

function cleanupSuperLikeUsersForToday(
  monitorId,
  scanDate
) {
  initSuperLikeUsersTable();

  const result =
    db.prepare(`
      DELETE FROM superlike_users
      WHERE monitor_id = ?
        AND scan_date <> ?
    `).run(
      monitorId,
      scanDate
    );

  return result.changes
    || 0;
}

function upsertSuperLikeUsers(
  monitorId,
  uidList,
  scanDate,
  rankStart
) {
  initSuperLikeUsersTable();

  if (
    !Array.isArray(uidList)
    ||
    uidList.length === 0
  ) {
    return 0;
  }

  const chinaNow =
    getChinaDateTime();

  const stmt =
    db.prepare(`
      INSERT INTO superlike_users(
        monitor_id,
        uid,
        scan_date,
        first_seen_at,
        last_seen_at,
        first_seen_rank,
        last_seen_rank
      )
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(uid) DO UPDATE SET
        monitor_id = excluded.monitor_id,
        scan_date = excluded.scan_date,
        last_seen_at = excluded.last_seen_at,
        last_seen_rank = excluded.last_seen_rank
    `);

  let saved = 0;

  db.exec('BEGIN');

  try {
    for (
      let i = 0;
      i < uidList.length;
      i++
    ) {
      const uid =
        String(
          uidList[i]
          || ''
        ).trim();

      if (!uid) {
        continue;
      }

      const rank =
        Number(rankStart)
        + i;

      stmt.run(
        monitorId,
        uid,
        scanDate,
        chinaNow,
        chinaNow,
        rank,
        rank
      );

      saved++;
    }

    db.exec('COMMIT');

  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }

    throw error;
  }

  return saved;
}

function deletePostsByUidSet(
  monitorId,
  uidSet
) {
  const uids =
    Array.from(uidSet || [])
      .map(
        uid =>
          String(uid || '').trim()
      )
      .filter(Boolean);

  if (uids.length === 0) {
    return 0;
  }

  const CHUNK_SIZE = 500;
  let deleted = 0;

  db.exec('BEGIN');

  try {
    for (
      let i = 0;
      i < uids.length;
      i += CHUNK_SIZE
    ) {
      const chunk =
        uids.slice(
          i,
          i + CHUNK_SIZE
        );

      const placeholders =
        chunk
          .map(() => '?')
          .join(',');

      const result =
        db.prepare(`
          DELETE FROM superlike_posts
          WHERE monitor_id = ?
            AND uid IN (${placeholders})
        `).run(
          monitorId,
          ...chunk
        );

      deleted +=
        result.changes
        || 0;
    }

    db.exec('COMMIT');

  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }

    throw error;
  }

  return deleted;
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
 * 评论数仍然 < 22：
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

        /*
         * Mode1 既然已经确认该 UID 是 SuperLike，
         * 同步写入 superlike_users，避免后续 Scan/Mode2/Mode3 再次处理。
         */
        const userInserted =
          saveSuperLikeUser(
            monitor.id,
            uid,
            getWeiboScanDate()
          );

        console.log(
          userInserted
            ? `[Recheck][SuperLike用户入库] UID=${uid} 已写入 superlike_users`
            : `[Recheck][SuperLike用户已存在] UID=${uid}`
        );


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
           * 评论仍然 < 22：
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
function getCommentCheckIntervalMinutes(commentsCount) {
  const count =
    Number(commentsCount) || 0;

  if (count >= 18) return 0.5;
  if (count >= 15) return 1;
  if (count >= 10) return 2;
  if (count >= 5) return 10;
  return 30;
}

function getHotCandidatePosts(limit = COMMENT_HOT_BATCH_SIZE) {
  /*
   * Mode2 每30秒直接扫描整张 superlike_posts：
   * - 不看 comment_last_checked_at
   * - 不看 comment_next_check_at
   * - 只取 comments_count 最大的前60条
   * - comments_count 越接近21，越优先
   */
  return db.prepare(`
    SELECT
      id,
      monitor_id,
      post_id,
      uid,
      username,
      post_link,
      comments_count,
      comment_last_checked_at,
      comment_next_check_at
    FROM superlike_posts
    WHERE post_id IS NOT NULL
      AND post_id <> ''
      AND comments_count < ?
      AND NOT EXISTS (
        SELECT 1
        FROM superlike_users su
        WHERE su.uid = superlike_posts.uid
      )
    ORDER BY
      comments_count DESC,
      id DESC
    LIMIT ?
  `).all(
    LIGHT_COMMENT_DELETE_THRESHOLD,
    Number(limit)
  );
}

function scheduleNextCommentCheck(
  monitorId,
  postId,
  commentsCount
) {
  const minutes =
    getCommentCheckIntervalMinutes(
      commentsCount
    );

  db.prepare(`
    UPDATE superlike_posts
    SET
      comment_last_checked_at = CURRENT_TIMESTAMP,
      comment_next_check_at = datetime(
        'now',
        '+' || ? || ' minutes'
      )
    WHERE monitor_id = ?
      AND post_id = ?
  `).run(
    minutes,
    monitorId,
    postId
  );

  return minutes;
}

function isAbortError(error) {
  return !!error && (
    error.name === 'AbortError'
    || String(error.message || '').toLowerCase().includes('aborted')
  );
}

function isProxyConnectionError(message) {
  const text =
    String(
      message
      || ''
    );

  return (
    /ERR_TUNNEL_CONNECTION_FAILED/i.test(text)
    ||
    /ERR_PROXY_CONNECTION_FAILED/i.test(text)
    ||
    /ERR_CONNECTION_RESET/i.test(text)
    ||
    /ERR_CONNECTION_CLOSED/i.test(text)
    ||
    /ERR_CONNECTION_REFUSED/i.test(text)
    ||
    /ERR_NAME_NOT_RESOLVED/i.test(text)
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
  /*
   * 全量 UID 分批轮询：
   * - superlike_posts 中所有尚未确认 SuperLike 的 UID 都进入队列
   * - 同一个 UID 无论有多少帖子，Profile 只检查一次
   * - 从未检查过的 UID 最优先
   * - 之后按 profile_last_checked_at 最旧的优先
   * - 每轮最多 PROFILE_VERIFY_BATCH_SIZE 个
   *
   * 这样不会每轮暴力扫全库，但只要程序持续运行，
   * 所有候选 UID 都会被循环覆盖。
   */
  return db.prepare(`
    SELECT
      p.uid,
      MAX(p.username) AS username,
      COUNT(*) AS post_count,
      MAX(p.id) AS latest_id,
      MIN(p.first_seen_at) AS first_seen_at,
      MAX(p.profile_last_checked_at) AS profile_last_checked_at
    FROM superlike_posts p
    WHERE p.monitor_id = ?
      AND p.uid IS NOT NULL
      AND p.uid <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM superlike_users su
        WHERE su.uid = p.uid
      )
    GROUP BY p.uid
    ORDER BY
      CASE
        WHEN MAX(p.profile_last_checked_at) IS NULL
        THEN 0
        ELSE 1
      END ASC,
      datetime(MAX(p.profile_last_checked_at)) ASC,
      MIN(p.first_seen_at) ASC,
      MAX(p.id) DESC
    LIMIT ?
  `).all(
    monitorId,
    PROFILE_VERIFY_BATCH_SIZE
  );
}

function markProfileChecked(
  monitorId,
  uid,
  status
) {
  db.prepare(`
    UPDATE superlike_posts
    SET
      profile_last_checked_at = CURRENT_TIMESTAMP,
      profile_status = ?
    WHERE monitor_id = ?
      AND uid = ?
  `).run(
    status,
    monitorId,
    uid
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
  console.log('# 数据库顺序：按最久未检查 UID 轮询');
  console.log('# 优先使用 weibo-good-proxies.txt 健康代理池；连接失败最多换5个后回本地IP');
  console.log('########################################');

  let context = null;
  let page = null;
  let proxyAssignment = null;
  let proxyFailureCount = 0;

  const profileDir =
    path.join(
      __dirname,
      '..',
      'data',
      'superlike-browser-profile-scan'
    );

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

  async function launchVisibleContext() {
    await launchVisibleContext();
  }

  async function closeCurrentContext() {
    if (context) {
      try {
        await context.close();
      } catch {
        // ignore
      }
    }

    context = null;
    page = null;
  }

  try {
    throwIfAborted(signal);

    const { chromium } =
      require('playwright');

    /*
     * 使用和 SuperLike 扫描一致的持久化 Profile。
     * 这样可以复用已经建立好的微博 visitor/session。
     */
    proxyAssignment =
      await MODE3_PROXY_POOL.acquire();

    let proxy =
      proxyAssignment.proxy;

    if (
      proxyAssignment.allCoolingDown
      ||
      !proxy
    ) {
      console.log(
        '[模式3] 当前没有可用健康代理，本轮使用本地IP。'
      );

      proxyAssignment = {
        configured: false,
        raw: null,
        proxy: null,
        masked: 'LOCAL'
      };

      proxy = null;
    } else {
      console.log(
        `[模式3] 本轮优先使用健康代理：${proxyAssignment.masked}`
      );
    }

    async function relaunchContext(
      nextProxy
    ) {
      await closeCurrentContext();

      context =
        await chromium.launchPersistentContext(
          profileDir,
          {
            headless: true,
            ...(nextProxy ? { proxy: nextProxy } : {}),
            viewport: {
              width: 1280,
              height: 900
            }
          }
        );
    }

    await relaunchContext(
      proxy
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

          const message =
            String(
              result?.message
              || 'unknown'
            );

          console.log(
            `[轻量Profile ${i + 1}/${users.length}] ` +
            `UID=${uid} | 失败 | ${message}`
          );

          const proxyConnectionFailed =
            /ERR_(?:TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED)|proxy.*(?:failed|error)|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT/i.test(
              message
            );

          if (
            proxyConnectionFailed
            &&
            proxyAssignment?.raw
          ) {
            MODE3_PROXY_POOL.remove(
              proxyAssignment.raw
            );

            proxyFailureCount++;

            console.log(
              `[模式3] 健康代理连接失败 ${proxyFailureCount}/5，已淘汰：${proxyAssignment.masked}`
            );

            if (
              proxyFailureCount < 5
            ) {
              proxyAssignment =
                await MODE3_PROXY_POOL.acquire();

              if (
                proxyAssignment.proxy
              ) {
                proxy =
                  proxyAssignment.proxy;

                console.log(
                  `[模式3] 立即切换下一个健康代理：${proxyAssignment.masked}`
                );

                await relaunchContext(
                  proxy
                );

                i--;
                continue;
              }
            }

            console.log(
              '[模式3] 连续最多5个健康代理失败/无可用代理，本轮切回本地IP。'
            );

            proxyAssignment = {
              configured: false,
              raw: null,
              proxy: null,
              masked: 'LOCAL'
            };

            proxy = null;

            await relaunchContext(
              null
            );

            i--;
            continue;
          }

          if (
            result?.blocked
            &&
            proxyAssignment?.raw
          ) {
            MODE3_PROXY_POOL.markBlocked(
              proxyAssignment.raw
            );

            console.log(
              `[模式3] 当前代理命中418，进入冷却并切回本地IP：${proxyAssignment.masked}`
            );

            proxyAssignment = {
              configured: false,
              raw: null,
              proxy: null,
              masked: 'LOCAL'
            };

            proxy = null;

            await relaunchContext(
              null
            );

            i--;
            continue;
          }

          await sleep(
            LIGHT_REQUEST_DELAY_MS,
            signal
          );

          continue;
        }

        stats.checked++;

        markProfileChecked(
          monitor.id,
          uid,
          result.hasSuperLike
            ? 'SUPERLIKE'
            : 'NO_SUPERLIKE'
        );

        if (
          result.hasSuperLike
        ) {
          stats.hasSuperLike++;

          /*
           * Profile 已确认是 SuperLike：
           * 先写入 superlike_users，后续 Scan/Mode4 都能本地直接过滤。
           */
          saveSuperLikeUser(
            monitor.id,
            uid,
            getWeiboScanDate()
          );

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
    getHotCandidatePosts();

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
  console.log(`# 评论 >= ${LIGHT_COMMENT_DELETE_THRESHOLD} → 删除帖子`);
  console.log('# 其余 → 只更新 comments_count');
  console.log('# 每30秒启动一轮，直接从整张 superlike_posts 取评论数最高的60条');
  console.log('# 不使用 comment_last_checked_at / comment_next_check_at 作为筛选条件');
  console.log('# ORDER BY comments_count DESC，越接近21条越优先');
  console.log(`本轮最多=${COMMENT_HOT_BATCH_SIZE} | 实际到期=${posts.length}`);
  console.log('########################################');

  let context = null;
  let page = null;
  let proxyAssignment = null;
  let proxyFailureCount = 0;

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

    proxyAssignment =
      await MODE2_PROXY_POOL.acquire();

    let proxy =
      proxyAssignment.proxy;

    if (
      proxyAssignment.allCoolingDown
      ||
      !proxy
    ) {
      console.log(
        '[模式2] 当前没有可用健康代理，本轮直接使用本地IP。'
      );

      proxyAssignment = {
        configured: false,
        raw: null,
        proxy: null,
        masked: 'LOCAL'
      };

      proxy = null;
    } else {
      console.log(
        `[模式2] 本轮优先使用健康代理：${proxyAssignment.masked}`
      );
    }

    context =
      await chromium.launchPersistentContext(
        profileDir,
        {
          headless: true,
          ...(proxy ? { proxy } : {}),
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

          if (
            proxyAssignment?.raw
          ) {
            MODE2_PROXY_POOL.markBlocked(
              proxyAssignment.raw
            );

            console.log(
              `[模式2] 当前代理命中418，已进入冷却：${proxyAssignment.masked}`
            );
          }

          break;
        }

        console.log(
          `[轻量浏览器 ${i + 1}/${posts.length}] ` +
          `ID=${post.id} | Post=${post.post_id} | 失败 | ${result.message || 'unknown'}`
        );

        if (
          isProxyConnectionError(
            result.message
          )
          &&
          proxyAssignment?.raw
        ) {
          MODE2_PROXY_POOL.remove(
            proxyAssignment.raw
          );

          console.log(
            `[模式2] 当前健康代理连接失败，已从本进程池淘汰：${proxyAssignment.masked}`
          );

          proxyFailureCount++;

          if (context) {
            try {
              await context.close();
            } catch {
              // ignore
            }
          }

          if (
            proxyFailureCount < 5
          ) {
            console.log(
              `[模式2] 健康代理连接失败 ${proxyFailureCount}/5，立即换下一个代理重试当前帖子。`
            );

            proxyAssignment =
              await MODE2_PROXY_POOL.acquire();

            if (
              proxyAssignment.allCoolingDown
              ||
              !proxyAssignment.proxy
            ) {
              console.log(
                '[模式2] 当前没有可用动态代理，提前切回本地IP。'
              );

              proxyAssignment = {
                configured: false,
                raw: null,
                proxy: null,
                masked: 'LOCAL'
              };
            }
          } else {
            console.log(
              '[模式2] 连续5个健康代理均连接失败，当前轮切回本地IP。'
            );

            proxyAssignment = {
              configured: false,
              raw: null,
              proxy: null,
              masked: 'LOCAL'
            };
          }

          const retryProxy =
            proxyAssignment.proxy;

          context =
            await chromium.launchPersistentContext(
              profileDir,
              {
                headless: true,
                ...(retryProxy ? { proxy: retryProxy } : {}),
                viewport: {
                  width: 1280,
                  height: 900
                }
              }
            );

          page =
            context.pages()[0]
            || await context.newPage();

          console.log(
            retryProxy
              ? `[模式2] 当前轮切换代理：${proxyAssignment.masked}`
              : '[模式2] 当前轮已切回本地IP'
          );

          /*
           * i-- 后 continue：
           * 下一次循环重新处理当前这一条。
           */
          i--;
          continue;
        }

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
        commentsCount >=
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

        const nextMinutes =
          scheduleNextCommentCheck(
            post.monitor_id,
            post.post_id,
            commentsCount
          );

        stats.updated++;

        console.log(
          `[轻量浏览器 ${i + 1}/${posts.length}] ` +
          `ID=${post.id} | Post=${post.post_id} | 评论=${commentsCount} | ` +
          `更新保留 | 下次≈${nextMinutes}分钟后`
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
 * 模式4：直接读取超LIKE List，只取 UID，批量删除 DB
 *
 * 规则：
 * - 第一次：最多读取 50 页
 * - 后续：从第一页开始，一直读到上次保存的 last_uid
 * - 白天：20分钟一次
 * - 19点以后：5分钟一次
 * ============================================================
 */

function buildSuperLikeListApiUrl(
  config,
  sinceId = null
) {
  const url =
    new URL(
      'https://m.weibo.cn/api/container/getIndex'
    );

  url.searchParams.set(
    'containerid',
    config.chaoLikeListContainerId
  );

  url.searchParams.set(
    'title',
    '超LIKE榜'
  );

  if (sinceId) {
    url.searchParams.set(
      'since_id',
      String(sinceId)
    );
  }

  return url.toString();
}

function extractSuperLikeListUids(
  json
) {
  const result = [];

  const cards =
    Array.isArray(
      json?.data?.cards
    )
      ? json.data.cards
      : [];

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
      const uid =
        item?.user?.id
        ??
        item?.user?.idstr;

      if (
        uid !== undefined
        &&
        uid !== null
        &&
        String(uid).trim() !== ''
      ) {
        result.push(
          String(uid)
        );
      }
    }
  }

  return result;
}

function extractSuperLikeListNextSinceId(
  json
) {
  const value =
    json?.data?.cardlistInfo?.since_id
    ?? null;

  return (
    value === null
    ||
    value === undefined
    ||
    value === ''
  )
    ? null
    : String(value);
}

async function fetchSuperLikeListPage(
  page,
  config,
  sinceId = null,
  signal = null
) {
  throwIfAborted(signal);

  const url =
    buildSuperLikeListApiUrl(
      config,
      sinceId
    );

  let response;

  try {
    response =
      await page.goto(
        url,
        {
          waitUntil:
            'domcontentloaded',

          timeout:
            LIGHT_REQUEST_TIMEOUT_MS
        }
      );

  } catch (error) {
    if (
      signal?.aborted
      ||
      isAbortError(error)
    ) {
      throw error;
    }

    return {
      ok: false,
      blocked: false,
      status: 0,
      finalUrl:
        page.url()
        || url,
      bodyPreview: '',
      message:
        `chaolikenew page.goto失败：${error.message}`
    };
  }

  throwIfAborted(signal);

  const status =
    response
      ? response.status()
      : 0;

  const finalUrl =
    page.url()
    || url;

  let body = '';

  try {
    body =
      response
        ? await response.text()
        : '';

  } catch {
    try {
      body =
        await page.locator('body')
          .innerText();

    } catch {
      body = '';
    }
  }

  const bodyPreview =
    String(body || '')
      .replace(/\s+/g, ' ')
      .slice(0, 300);

  if (status === 418) {
    return {
      ok: false,
      blocked: true,
      status,
      finalUrl,
      bodyPreview,
      message:
        'chaolikenew HTTP 418'
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
      status,
      finalUrl,
      bodyPreview,
      message:
        `chaolikenew HTTP ${status}`
    };
  }

  if (
    isWeiboLoginPageUrl(
      finalUrl
    )
  ) {
    return {
      ok: false,
      blocked: false,
      status,
      finalUrl,
      bodyPreview,
      message:
        'chaolikenew 被重定向到微博登录页'
    };
  }

  let json;

  try {
    json =
      JSON.parse(
        body
      );

  } catch (error) {
    return {
      ok: false,
      blocked: false,
      status,
      finalUrl,
      bodyPreview,
      message:
        `chaolikenew JSON解析失败：${error.message}`
    };
  }

  if (
    Number(
      json?.ok
      ?? 0
    )
    !== 1
  ) {
    return {
      ok: false,
      blocked: false,
      status,
      finalUrl,
      bodyPreview,
      message:
        `chaolikenew API ok=${json?.ok}`
    };
  }

  return {
    ok: true,
    blocked: false,
    status,
    json,
    url,
    finalUrl,
    bodyPreview
  };
}


function isWeiboLoginPageUrl(
  url
) {
  const text =
    String(url || '');

  return (
    /passport\.weibo\.com\/sso\/signin/i.test(text)
    ||
    /visitor\.passport\.weibo\.cn\/visitor\/visitor/i.test(text)
    ||
    /passport\.weibo\.cn/i.test(text)
  );
}

async function refreshWeiboVisitorSession(
  page,
  signal = null
) {
  throwIfAborted(signal);

  console.log(
    '[模式4] 检测到微博 Visitor/登录跳转，正在自动刷新 m.weibo.cn Session...'
  );

  try {
    await page.goto(
      'https://m.weibo.cn/',
      {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      }
    );

    await page.waitForTimeout(
      3000
    );

    throwIfAborted(signal);

    console.log(
      `[模式4] Session刷新页面已打开 | 当前URL=${page.url()}`
    );

    return true;

  } catch (error) {
    if (
      signal?.aborted
      ||
      isAbortError(error)
    ) {
      throw error;
    }

    console.log(
      `[模式4] 自动刷新 Session 失败：${error.message}`
    );

    return false;
  }
}


async function runSuperLikeListRecheck(
  context,
  page,
  signal = null
) {
  const monitors =
    getSuperLikeMonitors();

  console.log('');
  console.log('########################################');
  console.log('# SuperLike Recheck - 模式4 List UID模式（浏览器常驻）');
  console.log(`# 当天首次最多 ${LIST_FIRST_RUN_MAX_PAGES} 页`);
  console.log(`# 后续最大页数 = 人数增量 / 20 + ${LIST_DELTA_SAFETY_PAGES} 页保险`);
  console.log('# 同时命中上次 last_uid 可提前停止');
  console.log(`# 白天 ${LIST_DAY_INTERVAL_MS / 60000} 分钟一次`);
  console.log(`# 19:00-23:59 ${LIST_NIGHT_INTERVAL_MS / 60000} 分钟一次`);
  console.log('########################################');

  if (!context || !page || page.isClosed()) {
    throw new Error('模式4浏览器上下文不可用');
  }

    for (
      const monitor
      of monitors
    ) {
      throwIfAborted(signal);

      const config =
        parseTopicHomepage(
          monitor.url
        );

      const state =
        getSuperLikeListState(
          monitor.id
        );

      const previousLastUid =
        state?.lastUid
        || null;

      const today =
        getWeiboScanDate();

      const sameDay =
        state?.scanDate ===
        today;

      let currentTotal =
        null;

      let cleanupDone =
        false;

      let maxPages =
        LIST_FIRST_RUN_MAX_PAGES;

      let firstRun =
        !sameDay;

      let sinceId =
        null;

      let pageNumber =
        0;

      let reachedBoundary =
        false;

      let completed =
        false;

      let newestUid =
        null;

      const uidSet =
        new Set();

      console.log('');
      console.log(
        `[模式4] Monitor=${monitor.name}`
      );

      console.log(
        firstRun
          ? `[模式4] 当天首次运行：最多抓 ${LIST_FIRST_RUN_MAX_PAGES} 页`
          : `[模式4] 上次状态：日期=${state?.scanDate || '-'} | 总人数=${state?.lastTotal ?? '-'} | 边界UID=${previousLastUid || '-'}`
      );

      while (true) {
        throwIfAborted(signal);

        if (
          pageNumber >=
            maxPages
        ) {
          completed =
            true;

          console.log(
            firstRun
              ? `[模式4] 当天首次运行已成功抓满 ${maxPages} 页。`
              : `[模式4] 已达到本轮人数增量计算上限 ${maxPages} 页。`
          );

          break;
        }

        let result =
          await fetchSuperLikeListPage(
            page,
            config,
            sinceId,
            signal
          );

        if (!result.ok) {
          if (result.blocked) {
            console.log(
              `[模式4] HTTP 418，本轮停止 | Monitor=${monitor.name} | ` +
              `status=${result.status ?? '-'} | ` +
              `url=${result.finalUrl || '-'} | ` +
              `body=${result.bodyPreview || '-'}`
            );
            break;
          }

          if (
            isWeiboLoginPageUrl(
              result.finalUrl
            )
            ||
            /登录页/i.test(
              String(
                result.message
                || ''
              )
            )
          ) {
            console.log(
              `[模式4] 第${pageNumber + 1}页进入微博 Visitor/登录页面。`
            );

            let loginOk =
              false;

            const refreshed =
              await refreshWeiboVisitorSession(
                page,
                signal
              );

            if (refreshed) {
              for (
                let retry = 0;
                retry < 10;
                retry++
              ) {
                throwIfAborted(signal);

                await page.waitForTimeout(
                  1500
                );

                result =
                  await fetchSuperLikeListPage(
                    page,
                    config,
                    sinceId,
                    signal
                  );

                if (result.ok) {
                  loginOk =
                    true;

                  console.log(
                    `[模式4] Visitor/Session 已恢复，继续第${pageNumber + 1}页。`
                  );

                  break;
                }

                if (
                  !isWeiboLoginPageUrl(
                    result.finalUrl
                  )
                  &&
                  !/登录页|Visitor/i.test(
                    String(
                      result.message
                      || ''
                    )
                  )
                ) {
                  break;
                }
              }
            }

            if (!loginOk) {
              console.log(
                '[模式4] 自动恢复失败；请把后台浏览器窗口打开并手动登录微博。'
              );

              for (
                let retry = 0;
                retry < 300;
                retry++
              ) {
                throwIfAborted(signal);

                await page.waitForTimeout(
                  2000
                );

                result =
                  await fetchSuperLikeListPage(
                    page,
                    config,
                    sinceId,
                    signal
                  );

                if (result.ok) {
                  loginOk =
                    true;

                  console.log(
                    `[模式4] 登录状态已恢复，继续第${pageNumber + 1}页。`
                  );

                  break;
                }

                if (
                  !isWeiboLoginPageUrl(
                    result.finalUrl
                  )
                  &&
                  !/登录页|Visitor/i.test(
                    String(
                      result.message
                      || ''
                    )
                  )
                ) {
                  break;
                }
              }
            }

            if (!loginOk) {
              console.log(
                `[模式4] 第${pageNumber + 1}页登录后仍无法读取 | ${result.message} | ` +
                `status=${result.status ?? '-'} | ` +
                `url=${result.finalUrl || '-'} | ` +
                `body=${result.bodyPreview || '-'}`
              );

              console.log(
                '[模式4] 本轮未完整结束，不更新扫描边界。'
              );

              break;
            }

          } else {
            console.log(
              `[模式4] 第${pageNumber + 1}页失败 | ${result.message} | ` +
              `status=${result.status ?? '-'} | ` +
              `url=${result.finalUrl || '-'} | ` +
              `body=${result.bodyPreview || '-'}`
            );

            console.log(
              `[模式4] 本轮未完整结束，不更新扫描边界。`
            );

            break;
          }
        }

        pageNumber++;

        const uids =
          extractSuperLikeListUids(
            result.json
          );

        if (
          pageNumber === 1
        ) {
          currentTotal =
            extractSuperLikeTotal(
              result.json
            );

          if (!cleanupDone) {
            const cleaned =
              cleanupSuperLikeUsersForToday(
                monitor.id,
                today
              );

            cleanupDone =
              true;

            console.log(
              `[模式4] 清理非当天超LIKE用户数据：${cleaned} 条`
            );
          }

          if (
            uids.length > 0
          ) {
            newestUid =
              uids[0];
          }

          if (
            !firstRun
            &&
            Number.isFinite(
              Number(currentTotal)
            )
            &&
            Number.isFinite(
              Number(state?.lastTotal)
            )
          ) {
            if (
              Number(currentTotal)
              <
              Number(state.lastTotal)
            ) {
              firstRun =
                true;

              maxPages =
                LIST_FIRST_RUN_MAX_PAGES;

              console.log(
                `[模式4] 当前总人数 ${currentTotal} < 上次 ${state.lastTotal}，视为榜单重算，按当天首次 ${maxPages} 页处理。`
              );

            } else {
              const delta =
                Number(currentTotal)
                -
                Number(state.lastTotal);

              maxPages =
                calculateListMaxPages(
                  currentTotal,
                  state.lastTotal
                );

              console.log(
                `[模式4] 超LIKE总人数：上次=${state.lastTotal} | 当前=${currentTotal} | 增量≈${delta} | 本轮最多=${maxPages}页（含${LIST_DELTA_SAFETY_PAGES}页保险）`
              );
            }

          } else if (
            firstRun
          ) {
            console.log(
              `[模式4] 当天首次总人数=${currentTotal ?? '未解析'} | 本轮最多=${maxPages}页`
            );

          } else {
            console.log(
              `[模式4] 总人数无法计算增量，回退到 ${maxPages} 页上限 + last_uid 边界。`
            );
          }
        }

        const nextSinceId =
          extractSuperLikeListNextSinceId(
            result.json
          );

        console.log(
          `[模式4] 第${pageNumber}页 | UID=${uids.length} | ` +
          `请求since_id=${sinceId || '-'} | ` +
          `返回since_id=${nextSinceId || '-'} | ` +
          `url=${result.finalUrl || result.url || '-'}`
        );


        const rankStart =
          (
            pageNumber - 1
          ) * 20
          + 1;

        const savedUsers =
          upsertSuperLikeUsers(
            monitor.id,
            uids,
            today,
            rankStart
          );

        console.log(
          `[模式4] 第${pageNumber}页保存当天超LIKE UID=${savedUsers} | 排名约=${rankStart}-${rankStart + Math.max(0, uids.length - 1)}`
        );

        for (
          const uid
          of uids
        ) {
          if (
            !firstRun
            &&
            previousLastUid
            &&
            uid === previousLastUid
          ) {
            reachedBoundary =
              true;

            console.log(
              `[模式4] 命中上次边界 UID=${uid}`
            );

            break;
          }

          uidSet.add(uid);
        }

        if (reachedBoundary) {
          completed =
            true;

          break;
        }

        if (
          !nextSinceId
          ||
          nextSinceId ===
            sinceId
        ) {
          console.log(
            '[模式4] 没有下一页 since_id，正常结束。'
          );

          completed =
            true;

          break;
        }

        sinceId =
          nextSinceId;

        await sleep(
          LIST_REQUEST_DELAY_MS,
          signal
        );
      }

      const deleted =
        deletePostsByUidSet(
          monitor.id,
          uidSet
        );

      console.log(
        `[模式4] Monitor=${monitor.name} | 扫描页=${pageNumber} | ` +
        `UID=${uidSet.size} | 删除DB记录=${deleted} | ` +
        `完整结束=${completed ? '是' : '否'} | ` +
        `命中旧边界=${reachedBoundary ? '是' : '否'}`
      );

      if (
        completed
        &&
        newestUid
      ) {
        saveSuperLikeListState(
          monitor.id,
          newestUid,
          today,
          currentTotal
        );

        console.log(
          `[模式4] 已更新状态：日期=${today} | 总人数=${currentTotal ?? '-'} | 边界UID=${newestUid}`
        );

      } else {
        console.log(
          `[模式4] 本轮 incomplete，保留旧边界不变。`
        );
      }
    }

}

function getChinaHour() {
  return Number(
    new Intl.DateTimeFormat(
      'en-US',
      {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        hour12: false
      }
    ).format(
      new Date()
    )
  );
}

function getMode4IntervalMs() {
  const hour =
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

  return (
    hour >= 19
    &&
    hour <= 23
  )
    ? LIST_NIGHT_INTERVAL_MS
    : LIST_DAY_INTERVAL_MS;
}

async function runMode4Forever() {
  const { chromium } =
    require('playwright');

  const profileDir =
    path.join(
      __dirname,
      '..',
      'data',
      'superlike-browser-profile-scan'
    );

  let context = null;
  let page = null;
  let round = 0;

  try {
    const proxy =
      getModeProxyConfig('4');

    if (proxy) {
      console.log(
        `[模式4] 使用代理：${proxy.server}`
      );
    }

    context =
      await chromium.launchPersistentContext(
        profileDir,
        {
          headless: false,
          ...(proxy ? { proxy } : {}),
          viewport: {
            width: 1280,
            height: 900
          }
        }
      );

    page =
      context.pages()[0]
      || await context.newPage();

    console.log('');
    console.log(
      '[模式4] 浏览器已启动并将常驻；后续轮次不会再关闭。'
    );
    console.log(
      `[模式4] Persistent Profile=${profileDir}`
    );

    while (true) {
      round++;

      const intervalMs =
        getMode4IntervalMs();

      console.log('');
      console.log(
        `[Recheck] ===== 模式4 第${round}轮开始 | 当前间隔=${intervalMs / 60000}分钟 =====`
      );

      const startedAt =
        Date.now();

      const controller =
        new AbortController();

      try {
        if (
          !page
          ||
          page.isClosed()
        ) {
          page =
            context.pages()[0]
            || await context.newPage();
        }

        await runSuperLikeListRecheck(
          context,
          page,
          controller.signal
        );

      } catch (error) {
        if (!isAbortError(error)) {
          console.error(
            `[Recheck] 模式4 第${round}轮异常：`,
            error
          );
        }
      }

      const elapsed =
        Date.now() - startedAt;

      const waitMs =
        Math.max(
          0,
          intervalMs - elapsed
        );

      if (waitMs > 0) {
        console.log(
          `[Recheck] 模式4 第${round}轮结束，${Math.round(waitMs / 60000)}分钟后进入下一轮；浏览器保持登录并继续常驻。`
        );

        await sleep(
          waitMs
        );
      }
    }

  } finally {
    if (context) {
      try {
        await context.close();
      } catch {
        // ignore
      }
    }
  }
}



/**
 * ============================================================
 * 模式2/3常驻轮询
 *
 * Mode2：30秒一轮，评论数降序 Top20。
 * Mode3：2分钟一轮，每轮最多30个 UID，按最久未检查优先。
 *
 * 到达下一轮边界时，如果上一轮仍未结束：
 * 先 abort 上一轮，再开启新一轮。
 * ============================================================
 */
async function runLightModeForever(mode) {
  let round = 0;

  const roundIntervalMs =
    mode === '2'
      ? MODE2_ROUND_INTERVAL_MS
      : MODE3_ROUND_INTERVAL_MS;

  console.log('');
  console.log(
    mode === '2'
      ? `[Recheck] 模式2：每 ${roundIntervalMs / 1000} 秒直接检查整表评论数最高的${COMMENT_HOT_BATCH_SIZE}条。`
      : `[Recheck] 模式3：每 ${roundIntervalMs / 60000} 分钟一轮，每轮最多${PROFILE_VERIFY_BATCH_SIZE}个UID，按最久未检查优先；19点后暂停。`
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

    const chinaHour =
      getChinaHour();

    /*
     * 19:00-23:59 的晚高峰：
     * Profile 请求收益低、418 风险高，Mode3 直接让路给 Scan/Mode4/评论 Hot Queue。
     */
    const skipNightProfile =
      mode === '3'
      && chinaHour >= LIST_NIGHT_START_HOUR
      && chinaHour <= 23;

    const roundPromise =
      (
        skipNightProfile
          ? (
              console.log(
                '[Recheck] 晚高峰暂停 Mode3 Profile；优先保障 Mode4 和评论 Hot Queue。'
              ),
              Promise.resolve()
            )
          : mode === '2'
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
            roundIntervalMs
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
        `[Recheck] ${mode === '2' ? roundIntervalMs / 1000 + '秒' : roundIntervalMs / 60000 + '分钟'}到：取消模式${mode}第${round}轮，立即开启下一轮。`
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
        roundIntervalMs - elapsed
      );

    if (waitMs > 0) {
      console.log(
        `[Recheck] 模式${mode} 第${round}轮已结束，等待下一轮边界。`
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
    || process.env.SUPERLIKE_RECHECK_MODE === '4'
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
    console.log('2 = 评论Top60热队列（每30秒；整表按评论数降序取60条；>=21删除）');
    console.log('3 = Profile全量UID分批轮询（每2分钟最多30个；最久未检查优先；晚19点后暂停）');
    console.log('4 = 超LIKE List UID模式（首次50页；后续扫到上次边界；白天20分钟，19点后5分钟）');

    rl.question('请输入 1、2、3 或 4：', answer => {
      rl.close();

      const mode =
        String(answer || '').trim();

      resolve(
        mode === '2'
        || mode === '3'
        || mode === '4'
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
  initSuperLikeListStateTable();
  initSuperLikeUsersTable();


  const mode =
    await askRecheckMode();


  /*
   * 模式确定后再创建日志文件。
   * 这样日志名会是：
   * recheck-superlike_mode1_YYYYMMDD_HHMMSS.log
   * ...
   * recheck-superlike_mode4_YYYYMMDD_HHMMSS.log
   */
  batchLogger =
    createBatchLogger(
      'recheck-superlike',
      mode
    );

  console.log(
    `[Recheck] 当前模式：mode${mode}`
  );


  if (mode === '4') {
    await runMode4Forever();
    return;
  }

  if (mode === '2' || mode === '3') {
    await runLightModeForever(mode);
    return;
  }


  // 模式2/3/4都已在上面 return；只有模式1才加载 Playwright。
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
  let mode1ProxyAssignment = null;
  let mode1ProxyFailureCount = 0;

  async function launchMode1Context(proxy) {
    if (context) {
      try {
        await context.close();
      } catch {
        // ignore
      }
    }

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
            true,

          ...(proxy ? { proxy } : {}),

          viewport: {
            width:
              1280,

            height:
              900
          }
        }
      );
  }


  try {
    mode1ProxyAssignment =
      await MODE1_PROXY_POOL.acquire();

    let proxy =
      mode1ProxyAssignment?.proxy
      || null;

    if (
      mode1ProxyAssignment?.allCoolingDown
      ||
      !proxy
    ) {
      mode1ProxyAssignment = null;
      proxy = null;

      console.log(
        '[模式1] 当前没有可用健康代理，使用本地IP。'
      );
    } else {
      console.log(
        `[模式1] 优先使用健康代理：${mode1ProxyAssignment.masked}`
      );
    }

    await launchMode1Context(proxy);


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
      let completed = false;

      while (!completed) {
        try {
          await recheckOneMonitor(
            context,
            monitor
          );

          completed = true;

        } catch (error) {
          const message =
            String(
              error?.message
              || error
              || ''
            );

          const proxyFailed =
            isProxyConnectionError(message)
            ||
            /ERR_TIMED_OUT/i.test(message)
            ||
            /Timeout \d+ms exceeded/i.test(message)
            ||
            /Navigation timeout/i.test(message);

          const blocked418 =
            /HTTP\s*418/i.test(message)
            ||
            /\b418\b/i.test(message);

          if (
            mode1ProxyAssignment?.raw
            &&
            (
              proxyFailed
              ||
              blocked418
            )
          ) {
            if (blocked418) {
              MODE1_PROXY_POOL.markBlocked(
                mode1ProxyAssignment.raw
              );

              console.log(
                `[模式1] 当前代理命中418，进入冷却：${mode1ProxyAssignment.masked}`
              );
            } else {
              MODE1_PROXY_POOL.remove(
                mode1ProxyAssignment.raw
              );

              console.log(
                `[模式1] 当前代理连接失败，已淘汰：${mode1ProxyAssignment.masked}`
              );
            }

            mode1ProxyFailureCount++;

            if (
              mode1ProxyFailureCount
              < 5
            ) {
              const next =
                await MODE1_PROXY_POOL.acquire();

              if (
                next?.proxy
                &&
                !next.allCoolingDown
              ) {
                mode1ProxyAssignment =
                  next;

                console.log(
                  `[模式1] 切换健康代理：${next.masked}（失败${mode1ProxyFailureCount}/5）`
                );

                await launchMode1Context(
                  next.proxy
                );

                continue;
              }
            }

            console.log(
              '[模式1] 连续代理失败或当前无可用代理，切回本地IP继续。'
            );

            mode1ProxyAssignment =
              null;

            await launchMode1Context(
              null
            );

            continue;
          }

          throw error;
        }
      }
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