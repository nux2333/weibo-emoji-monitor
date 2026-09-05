const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'monitor.db');

fs.mkdirSync(DATA_DIR, { recursive: true });
console.log('SQLite DB:', DB_FILE);

const db = new DatabaseSync(DB_FILE);

function tableHasColumn(tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all()
    .some(row => row.name === columnName);
}

function ensureColumn(tableName, columnName, definition) {
  if (tableHasColumn(tableName, columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  console.log(`数据库字段已补充：${tableName}.${columnName}`);
}

function migrateSuperlikePostsIfNeeded() {
  const row = db.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type='table' AND name='superlike_posts'
  `).get();

  if (!row) return;

  const sql = String(row.sql || '');
  const hasMonitorId = tableHasColumn('superlike_posts', 'monitor_id');
  const hasOldUniquePostId =
    /post_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(sql);

  if (hasMonitorId && !hasOldUniquePostId) return;

  console.log('升级 superlike_posts 表结构...');

  db.exec(`
    PRAGMA foreign_keys = OFF;
    ALTER TABLE superlike_posts RENAME TO superlike_posts_old;

    CREATE TABLE superlike_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER,
      post_id TEXT NOT NULL,
      uid TEXT,
      username TEXT,
      post_link TEXT,
      post_text TEXT,
      comments_count INTEGER NOT NULL DEFAULT 0,
      current_has_superlike INTEGER NOT NULL DEFAULT 0,
      icon_summary TEXT,
      experience_7d INTEGER,
      post_created_at TEXT,
      /* 入库时间：固定保存中国时间（UTC+8），精确到秒；后续 UPDATE 不修改 */
      inserted_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      comment_last_checked_at TEXT,
      comment_next_check_at TEXT,
      profile_last_checked_at TEXT,
      profile_status TEXT NOT NULL DEFAULT 'UNKNOWN',
      raw_json TEXT,
      UNIQUE(monitor_id, post_id),
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    INSERT INTO superlike_posts(
      id, monitor_id, post_id, uid, username, post_link, post_text,
      comments_count, current_has_superlike, icon_summary, experience_7d,
      post_created_at, first_seen_at, last_seen_at, raw_json
    )
    SELECT
      id,
      ${hasMonitorId ? 'monitor_id' : 'NULL'},
      post_id, uid, username, post_link, post_text,
      comments_count, current_has_superlike, icon_summary, experience_7d,
      post_created_at, first_seen_at, last_seen_at, raw_json
    FROM superlike_posts_old;

    DROP TABLE superlike_posts_old;
    PRAGMA foreign_keys = ON;
  `);
}

function migrateSuperlikeUsersIfNeeded() {
  const row = db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'superlike_users'
  `).get();

  if (!row) return;

  const columns =
    db.prepare('PRAGMA table_info(superlike_users)').all()
      .map(item => String(item.name));

  const obsoleteColumns = [
    'first_seen_at',
    'first_seen_date',
    'last_seen_date'
  ];

  if (
    obsoleteColumns.every(
      column => !columns.includes(column)
    )
  ) {
    return;
  }

  console.log(
    '整理 superlike_users 表结构：移除 first_seen_at / first_seen_date / last_seen_date...'
  );

  /*
   * SQLite 删除多列在不同版本兼容性较差，所以重建表。
   * inserted_at 优先保留现值；旧库没有值时用 first_seen_at 转中国时间。
   */
  const insertedExpr =
    columns.includes('inserted_at')
      ? `COALESCE(NULLIF(inserted_at, ''), ${
          columns.includes('first_seen_at')
            ? "datetime(first_seen_at, '+8 hours')"
            : "datetime('now', '+8 hours')"
        })`
      : (
          columns.includes('first_seen_at')
            ? "datetime(first_seen_at, '+8 hours')"
            : "datetime('now', '+8 hours')"
        );

  db.exec(`
    PRAGMA foreign_keys = OFF;

    ALTER TABLE superlike_users
      RENAME TO superlike_users_old;

    CREATE TABLE superlike_users (
      monitor_id INTEGER NOT NULL,
      uid TEXT PRIMARY KEY,
      scan_date TEXT NOT NULL,
      inserted_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
      first_seen_rank INTEGER,
      last_seen_rank INTEGER,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    INSERT INTO superlike_users(
      monitor_id,
      uid,
      scan_date,
      inserted_at,
      last_seen_at,
      first_seen_rank,
      last_seen_rank
    )
    SELECT
      monitor_id,
      uid,
      scan_date,
      ${insertedExpr},
      CASE
        WHEN last_seen_at IS NOT NULL
          AND last_seen_at <> ''
          THEN datetime(last_seen_at, '+8 hours')
        ELSE datetime('now', '+8 hours')
      END,
      first_seen_rank,
      last_seen_rank
    FROM superlike_users_old;

    DROP TABLE superlike_users_old;

    PRAGMA foreign_keys = ON;
  `);
}


function initDatabase() {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 10000;

    CREATE TABLE IF NOT EXISTS monitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      emojis TEXT NOT NULL DEFAULT '[]',
      texts TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      monitor_type TEXT NOT NULL DEFAULT 'comments',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_run_at TEXT,
      last_status TEXT,
      history_next_page INTEGER,
      history_completed INTEGER NOT NULL DEFAULT 0,
      latest_last_run_at TEXT,
      latest_last_status TEXT,
      history_last_run_at TEXT,
      history_last_status TEXT
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      comment_id TEXT NOT NULL,
      buyer_nickname TEXT,
      customerid TEXT,
      sku_name TEXT,
      content TEXT NOT NULL,
      comment_time TEXT,
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(monitor_id, comment_id),
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS api_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      page_num INTEGER NOT NULL,
      api_url TEXT NOT NULL,
      http_status INTEGER,
      response_json TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      crawl_type TEXT NOT NULL DEFAULT 'legacy',
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS daily_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      stat_date TEXT NOT NULL,
      total_comments INTEGER NOT NULL DEFAULT 0,
      emoji_total INTEGER NOT NULL DEFAULT 0,
      non_emoji_total INTEGER NOT NULL DEFAULT 0,
      emoji_stats TEXT NOT NULL DEFAULT '{}',
      text_stats TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(monitor_id, stat_date),
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS superlike_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER,
      post_id TEXT NOT NULL,
      uid TEXT,
      username TEXT,
      post_link TEXT,
      post_text TEXT,
      comments_count INTEGER NOT NULL DEFAULT 0,
      current_has_superlike INTEGER NOT NULL DEFAULT 0,
      icon_summary TEXT,
      experience_7d INTEGER,
      post_created_at TEXT,
      /* 入库时间：固定保存中国时间（UTC+8），精确到秒；后续 UPDATE 不修改 */
      inserted_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      raw_json TEXT,
      UNIQUE(monitor_id, post_id),
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );


    CREATE TABLE IF NOT EXISTS superlike_list_state (
      monitor_id INTEGER PRIMARY KEY,
      last_uid TEXT,
      scan_date TEXT,
      last_total INTEGER,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );


    CREATE TABLE IF NOT EXISTS superlike_users (
      monitor_id INTEGER NOT NULL,
      uid TEXT PRIMARY KEY,
      scan_date TEXT NOT NULL,
      inserted_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
      first_seen_rank INTEGER,
      last_seen_rank INTEGER,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );


    CREATE TABLE IF NOT EXISTS superlike_scan_checkpoint (
      monitor_id INTEGER PRIMARY KEY,
      latest_post_id TEXT,
      latest_created_at TEXT,
      latest_created_at_ms INTEGER,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );


    /*
     * Scan 断点续扫游标。
     * 与正式 checkpoint 分离：正式 checkpoint 只在安全追到旧边界后推进；
     * resume 只记录“下一页从哪里继续”，失败/达到50页时保留。
     */
    CREATE TABLE IF NOT EXISTS superlike_scan_resume (
      monitor_id INTEGER PRIMARY KEY,
      checkpoint_post_id TEXT,
      checkpoint_created_at_ms INTEGER,
      sort_time_flow_id TEXT NOT NULL,
      template_url TEXT NOT NULL,
      next_page INTEGER NOT NULL,
      next_since_id TEXT,
      next_max_id TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    /*
     * SuperLike 页面黑粉关键词。
     * 页面“ 不显示猪 ”筛选会检查：
     * username / post_text / icon_summary。
     */
    CREATE TABLE IF NOT EXISTS superlike_black_keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );


    /*
     * 黑粉用户表。
     * uid 作为稳定唯一标识；用户名和主页链接用于展示/人工确认。
     */
    CREATE TABLE IF NOT EXISTS black_fan_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT UNIQUE,
      username TEXT,
      profile_link TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  ensureColumn('comments', 'buyer_nickname', 'TEXT');
  ensureColumn('comments', 'customerid', 'TEXT');
  ensureColumn('comments', 'sku_name', 'TEXT');

  ensureColumn('monitors', 'monitor_type', "TEXT NOT NULL DEFAULT 'comments'");
  ensureColumn('monitors', 'history_next_page', 'INTEGER');
  ensureColumn('monitors', 'history_completed', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('monitors', 'latest_last_run_at', 'TEXT');
  ensureColumn('monitors', 'latest_last_status', 'TEXT');
  ensureColumn('monitors', 'history_last_run_at', 'TEXT');
  ensureColumn('monitors', 'history_last_status', 'TEXT');

  ensureColumn('api_responses', 'crawl_type', "TEXT NOT NULL DEFAULT 'legacy'");

  ensureColumn('superlike_list_state', 'scan_date', 'TEXT');
  ensureColumn('superlike_list_state', 'last_total', 'INTEGER');

  // SuperLike 高效复检队列字段。
  // 旧数据库会在启动时自动补列，不需要手工 migration。
  // 入库时间固定为中国时间（UTC+8），精确到秒。
  // SQLite ALTER TABLE 不能给新增列直接使用 datetime() 非常量默认值，
  // 所以旧库先补列，再回填；新数据由 CREATE TABLE 的 DEFAULT 自动写入。
  ensureColumn('superlike_posts', 'inserted_at', 'TEXT');

  db.exec(`
    UPDATE superlike_posts
    SET inserted_at = COALESCE(
      inserted_at,
      CASE
        WHEN first_seen_at IS NOT NULL
          THEN datetime(first_seen_at, '+8 hours')
        ELSE datetime('now', '+8 hours')
      END
    )
    WHERE inserted_at IS NULL
       OR inserted_at = ''
  `);

    ensureColumn('superlike_posts', 'comment_last_checked_at', 'TEXT');
  ensureColumn('superlike_posts', 'comment_next_check_at', 'TEXT');
  ensureColumn('superlike_posts', 'profile_last_checked_at', 'TEXT');
  ensureColumn('superlike_posts', 'profile_status', "TEXT NOT NULL DEFAULT 'UNKNOWN'");

  /*
   * superlike_users 精简：
   * inserted_at = 第一次入库中国时间（永不更新）
   * last_seen_at = 最近一次确认中国时间（会更新）
   * first_seen_at / first_seen_date / last_seen_date 不再保留。
   */
  migrateSuperlikeUsersIfNeeded();

  ensureColumn('superlike_users', 'scan_date', 'TEXT');
  ensureColumn('superlike_users', 'inserted_at', 'TEXT');
  ensureColumn('superlike_users', 'last_seen_at', 'TEXT');
  ensureColumn('superlike_users', 'first_seen_rank', 'INTEGER');
  ensureColumn('superlike_users', 'last_seen_rank', 'INTEGER');

  // 兼容旧库：以前 superlike_users 使用 (monitor_id, uid) 复合主键，
  // 现在要求 uid 全局唯一。先合并/删除重复 uid，再建立唯一索引。
  db.exec(`
    DELETE FROM superlike_users
    WHERE rowid NOT IN (
      SELECT MIN(rowid)
      FROM superlike_users
      GROUP BY uid
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_superlike_users_uid_unique
      ON superlike_users(uid);
  `);

  migrateSuperlikePostsIfNeeded();
  
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_monitors_type_enabled
      ON monitors(monitor_type, enabled);

    CREATE INDEX IF NOT EXISTS idx_comments_monitor
      ON comments(monitor_id);
    CREATE INDEX IF NOT EXISTS idx_comments_comment_id
      ON comments(comment_id);
    CREATE INDEX IF NOT EXISTS idx_comments_time
      ON comments(comment_time);

    CREATE INDEX IF NOT EXISTS idx_api_responses_page
      ON api_responses(monitor_id, page_num);
    CREATE INDEX IF NOT EXISTS idx_api_responses_crawl_page
      ON api_responses(monitor_id, crawl_type, page_num);

    CREATE INDEX IF NOT EXISTS idx_daily_stats_monitor_date
      ON daily_stats(monitor_id, stat_date);

    CREATE INDEX IF NOT EXISTS idx_superlike_posts_monitor
      ON superlike_posts(monitor_id);
    CREATE INDEX IF NOT EXISTS idx_superlike_posts_uid
      ON superlike_posts(uid);
    CREATE INDEX IF NOT EXISTS idx_superlike_posts_comments
      ON superlike_posts(comments_count);
    CREATE INDEX IF NOT EXISTS idx_superlike_posts_superlike
      ON superlike_posts(current_has_superlike);
    CREATE INDEX IF NOT EXISTS idx_superlike_posts_last_seen
      ON superlike_posts(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_superlike_posts_comment_due
      ON superlike_posts(comment_next_check_at, comments_count);
    CREATE INDEX IF NOT EXISTS idx_superlike_posts_profile_due
      ON superlike_posts(profile_last_checked_at, first_seen_at, uid);


    CREATE INDEX IF NOT EXISTS idx_superlike_users_scan_date
      ON superlike_users(scan_date);
    CREATE INDEX IF NOT EXISTS idx_superlike_users_uid
      ON superlike_users(uid);

    CREATE INDEX IF NOT EXISTS idx_superlike_black_keywords_enabled
      ON superlike_black_keywords(enabled, keyword);

    CREATE INDEX IF NOT EXISTS idx_black_fan_users_uid
      ON black_fan_users(uid);

    CREATE INDEX IF NOT EXISTS idx_black_fan_users_username
      ON black_fan_users(username);
  `);

  /*
   * 初始黑粉关键词。
   * INSERT OR IGNORE：以后手工增加/修改关键词不会被启动过程覆盖。
   */
  const seedBlackKeyword =
    db.prepare(`
      INSERT OR IGNORE INTO superlike_black_keywords(
        keyword,
        enabled
      )
      VALUES(?,1)
    `);

  for (
    const keyword
    of [
      '雷朋',
      '渝',
      'lp'
    ]
  ) {
    seedBlackKeyword.run(
      keyword
    );
  }
}


/* ============================================================
 * SuperLike DB helpers
 * ============================================================ */

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

function superLikePostIdExists(postId) {
  initDatabase();

  if (!postId) {
    return false;
  }

  return !!db.prepare(`
    SELECT 1
    FROM superlike_posts
    WHERE post_id = ?
    LIMIT 1
  `).get(String(postId));
}

function getExistingSuperLikeUids() {
  initDatabase();

  return new Set(
    db.prepare(`
      SELECT DISTINCT uid
      FROM superlike_posts
      WHERE uid IS NOT NULL
        AND uid <> ''
    `).all()
      .map(row => String(row.uid))
  );
}

function getLocalDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function isSuperLikeUser(uid) {
  initDatabase();

  const normalizedUid =
    String(uid || '').trim();

  if (!normalizedUid) {
    return false;
  }

  return !!db.prepare(`
    SELECT 1
    FROM superlike_users
    WHERE uid = ?
    LIMIT 1
  `).get(
    normalizedUid
  );
}

function getRecentSuperLikeProfileStatus(
  monitorId,
  uid,
  cacheMinutes = 15
) {
  initDatabase();

  const normalizedMonitorId =
    Number(monitorId);

  const normalizedUid =
    String(uid || '').trim();

  const minutes =
    Math.max(
      0,
      Number(cacheMinutes) || 0
    );

  if (
    !Number.isFinite(normalizedMonitorId)
    ||
    normalizedMonitorId <= 0
    ||
    !normalizedUid
  ) {
    return null;
  }

  const row =
    db.prepare(`
      SELECT
        profile_status,
        profile_last_checked_at
      FROM superlike_posts
      WHERE monitor_id = ?
        AND uid = ?
        AND profile_last_checked_at IS NOT NULL
        AND datetime(profile_last_checked_at)
            >= datetime('now', '-' || ? || ' minutes')
      ORDER BY datetime(profile_last_checked_at) DESC
      LIMIT 1
    `).get(
      normalizedMonitorId,
      normalizedUid,
      minutes
    );

  return row
    ? {
        status:
          String(
            row.profile_status
            || 'UNKNOWN'
          ),

        checkedAt:
          row.profile_last_checked_at
          || null
      }
    : null;
}

function markSuperLikeProfileChecked(
  monitorId,
  uid,
  status
) {
  initDatabase();

  const normalizedMonitorId =
    Number(monitorId);

  const normalizedUid =
    String(uid || '').trim();

  const normalizedStatus =
    String(status || 'UNKNOWN')
      .trim()
      .toUpperCase();

  if (
    !Number.isFinite(normalizedMonitorId)
    ||
    normalizedMonitorId <= 0
    ||
    !normalizedUid
  ) {
    return 0;
  }

  const result =
    db.prepare(`
      UPDATE superlike_posts
      SET
        profile_last_checked_at = CURRENT_TIMESTAMP,
        profile_status = ?
      WHERE monitor_id = ?
        AND uid = ?
    `).run(
      normalizedStatus,
      normalizedMonitorId,
      normalizedUid
    );

  return result.changes || 0;
}

function saveSuperLikeUser(monitorId, uid, scanDate = null) {
  initDatabase();

  const normalizedMonitorId = Number(monitorId);
  const normalizedUid = String(uid || '').trim();

  if (!Number.isFinite(normalizedMonitorId) || normalizedMonitorId <= 0) {
    throw new Error('saveSuperLikeUser 缺少有效 monitorId');
  }

  if (!normalizedUid) {
    return false;
  }

  const date = scanDate || getLocalDateString();

  const existed = !!db.prepare(`
    SELECT 1
    FROM superlike_users
    WHERE uid = ?
    LIMIT 1
  `).get(normalizedUid);

  db.prepare(`
    INSERT INTO superlike_users(
      monitor_id,
      uid,
      scan_date,
      inserted_at,
      last_seen_at
    )
    VALUES(
      ?, ?, ?,
      datetime('now', '+8 hours'),
      datetime('now', '+8 hours')
    )
    ON CONFLICT(uid)
    DO UPDATE SET
      scan_date = excluded.scan_date,
      last_seen_at = datetime('now', '+8 hours')
  `).run(
    normalizedMonitorId,
    normalizedUid,
    date
  );

  return !existed;
}

function saveSuperLikeTargetPost(data = {}) {
  initDatabase();

  const monitorId = Number(data.monitorId);
  const postId = String(data.postId || '').trim();
  const uid = String(data.uid || '').trim();
  const username = data.username || '';
  const postLink = data.postLink || null;
  const postText = data.postText || '';
  const commentsCount = Number(data.commentsCount);
  const iconSummary = data.iconSummary || '无';
  const postCreatedAt = data.postCreatedAt || null;
  const postCreatedAtMs = Number(data.postCreatedAtMs);
  const rawJson = data.rawJson || null;

  if (!Number.isFinite(monitorId) || monitorId <= 0) {
    throw new Error('saveSuperLikeTargetPost 缺少有效 monitorId');
  }
  if (!postId) {
    throw new Error('saveSuperLikeTargetPost 缺少 postId');
  }
  if (!uid) {
    throw new Error('saveSuperLikeTargetPost 缺少 uid');
  }

  const existing = db.prepare(`
    SELECT
      id,
      post_id,
      comments_count,
      post_created_at
    FROM superlike_posts
    WHERE monitor_id = ?
      AND uid = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(monitorId, uid);

  if (existing) {
    const existingComments = Number(existing.comments_count);
    const existingMs = existing.post_created_at
      ? Date.parse(existing.post_created_at)
      : null;

    const shouldReplace =
      (
        Number.isFinite(commentsCount)
        && (
          !Number.isFinite(existingComments)
          || commentsCount > existingComments
        )
      )
      ||
      (
        Number.isFinite(commentsCount)
        && Number.isFinite(existingComments)
        && commentsCount === existingComments
        && Number.isFinite(postCreatedAtMs)
        && (
          !Number.isFinite(existingMs)
          || postCreatedAtMs > existingMs
        )
      );

    if (!shouldReplace) {
      return {
        status: 'kept_existing',
        postId: String(existing.post_id),
        uid
      };
    }

    db.prepare(`
      DELETE FROM superlike_posts
      WHERE monitor_id = ?
        AND uid = ?
    `).run(monitorId, uid);
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
      ?,?,?,?,?,?,?,
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
    uid,
    username,
    postLink,
    postText,
    commentsCount,
    iconSummary,
    postCreatedAt,
    rawJson
  );

  return {
    status: existing ? 'replaced' : 'inserted',
    postId,
    uid,
    username,
    postLink,
    commentsCount,
    iconSummary
  };
}

function deletePostsByUidSet(uidSet) {
  initDatabase();

  const uids = Array.from(uidSet || [])
    .map(uid => String(uid || '').trim())
    .filter(Boolean);

  if (uids.length === 0) {
    return 0;
  }

  const CHUNK_SIZE = 500;
  let deleted = 0;

  db.exec('BEGIN');

  try {
    for (let i = 0; i < uids.length; i += CHUNK_SIZE) {
      const chunk = uids.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');

      const result = db.prepare(`
        DELETE FROM superlike_posts
        WHERE uid IN (${placeholders})
      `).run(...chunk);

      deleted += result.changes || 0;
    }

    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback error
    }
    throw error;
  }

  return deleted;
}

function cleanupSuperLikePostsByUsersTable() {
  initDatabase();

  const result = db.prepare(`
    DELETE FROM superlike_posts
    WHERE uid IN (
      SELECT uid
      FROM superlike_users
    )
  `).run();

  return result.changes || 0;
}

function getScanCheckpoint(monitorId) {
  initDatabase();

  return db.prepare(`
    SELECT
      monitor_id,
      latest_post_id,
      latest_created_at,
      latest_created_at_ms
    FROM superlike_scan_checkpoint
    WHERE monitor_id = ?
  `).get(monitorId) || null;
}

function saveScanCheckpoint(
  monitorId,
  latestPostId,
  latestCreatedAt,
  latestCreatedAtMs
) {
  initDatabase();

  if (
    !latestPostId
    || !Number.isFinite(Number(latestCreatedAtMs))
  ) {
    return false;
  }

  db.prepare(`
    INSERT INTO superlike_scan_checkpoint(
      monitor_id,
      latest_post_id,
      latest_created_at,
      latest_created_at_ms,
      updated_at
    )
    VALUES(
      ?, ?, ?, ?,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(monitor_id)
    DO UPDATE SET
      latest_post_id = excluded.latest_post_id,
      latest_created_at = excluded.latest_created_at,
      latest_created_at_ms = excluded.latest_created_at_ms,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    monitorId,
    String(latestPostId),
    latestCreatedAt || null,
    Number(latestCreatedAtMs)
  );

  return true;
}

function getScanResume(monitorId) {
  initDatabase();

  return db.prepare(`
    SELECT
      monitor_id,
      checkpoint_post_id,
      checkpoint_created_at_ms,
      sort_time_flow_id,
      template_url,
      next_page,
      next_since_id,
      next_max_id,
      updated_at
    FROM superlike_scan_resume
    WHERE monitor_id = ?
  `).get(monitorId) || null;
}


function saveScanResume(
  monitorId,
  checkpoint,
  sortTimeFlowId,
  templateUrl,
  nextParams
) {
  initDatabase();

  if (
    !monitorId
    || !sortTimeFlowId
    || !templateUrl
    || !nextParams
    || Number(nextParams.page) < 2
  ) {
    return false;
  }

  db.prepare(`
    INSERT INTO superlike_scan_resume(
      monitor_id,
      checkpoint_post_id,
      checkpoint_created_at_ms,
      sort_time_flow_id,
      template_url,
      next_page,
      next_since_id,
      next_max_id,
      updated_at
    )
    VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(monitor_id)
    DO UPDATE SET
      checkpoint_post_id=excluded.checkpoint_post_id,
      checkpoint_created_at_ms=excluded.checkpoint_created_at_ms,
      sort_time_flow_id=excluded.sort_time_flow_id,
      template_url=excluded.template_url,
      next_page=excluded.next_page,
      next_since_id=excluded.next_since_id,
      next_max_id=excluded.next_max_id,
      updated_at=CURRENT_TIMESTAMP
  `).run(
    Number(monitorId),
    checkpoint?.latest_post_id
      ? String(checkpoint.latest_post_id)
      : null,
    Number.isFinite(Number(checkpoint?.latest_created_at_ms))
      ? Number(checkpoint.latest_created_at_ms)
      : null,
    String(sortTimeFlowId),
    String(templateUrl),
    Number(nextParams.page),
    nextParams.since_id == null
      ? null
      : String(nextParams.since_id),
    nextParams.max_id == null
      ? '0'
      : String(nextParams.max_id)
  );

  return true;
}


function clearScanResume(monitorId) {
  initDatabase();

  const result =
    db.prepare(`
      DELETE FROM superlike_scan_resume
      WHERE monitor_id = ?
    `).run(Number(monitorId));

  return Number(result.changes || 0);
}


function getMonitors(onlyEnabled = true) {
  initDatabase();
  return onlyEnabled
    ? db.prepare(`SELECT * FROM monitors WHERE enabled=1 ORDER BY id`).all()
    : db.prepare(`SELECT * FROM monitors ORDER BY id`).all();
}

function getMonitor(id) {
  initDatabase();
  return db.prepare(`SELECT * FROM monitors WHERE id=?`).get(id);
}

function getMonitorByUrl(url) {
  initDatabase();
  return db.prepare(`SELECT * FROM monitors WHERE url=? LIMIT 1`).get(url);
}

function createMonitor({
  name, url, emojis = [], texts = [], enabled = true,
  monitor_type = 'comments', monitorType = null
}) {
  initDatabase();
  const type = monitorType || monitor_type || 'comments';
  const result = db.prepare(`
    INSERT INTO monitors(
      name,url,emojis,texts,enabled,monitor_type,
      history_next_page,history_completed
    ) VALUES(?,?,?,?,?,?,1,0)
  `).run(
    name, url, JSON.stringify(emojis), JSON.stringify(texts),
    enabled ? 1 : 0, type
  );
  return Number(result.lastInsertRowid);
}

function updateMonitor(id, {
  name, url, emojis = [], texts = [], enabled = true,
  monitor_type = null, monitorType = null
}) {
  initDatabase();
  const current = getMonitor(id);
  const type = monitorType || monitor_type || current?.monitor_type || 'comments';
  db.prepare(`
    UPDATE monitors SET
      name=?, url=?, emojis=?, texts=?, enabled=?, monitor_type=?,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(
    name, url, JSON.stringify(emojis), JSON.stringify(texts),
    enabled ? 1 : 0, type, id
  );
}

function updateMonitorStatus(id, status) {
  initDatabase();
  db.prepare(`
    UPDATE monitors SET
      last_status=?, last_run_at=CURRENT_TIMESTAMP,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(status, id);
}

function updateLatestStatus(monitorId, status) {
  initDatabase();
  db.prepare(`
    UPDATE monitors SET
      latest_last_status=?, latest_last_run_at=CURRENT_TIMESTAMP,
      last_status=?, last_run_at=CURRENT_TIMESTAMP,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(status, status, monitorId);
}

function updateHistoryStatus(monitorId, status) {
  initDatabase();
  db.prepare(`
    UPDATE monitors SET
      history_last_status=?, history_last_run_at=CURRENT_TIMESTAMP,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(status, monitorId);
}

function setHistoryNextPage(monitorId, pageNum) {
  initDatabase();
  db.prepare(`
    UPDATE monitors SET history_next_page=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(Number(pageNum), monitorId);
}

function markHistoryCompleted(monitorId) {
  initDatabase();
  db.prepare(`
    UPDATE monitors SET
      history_completed=1,
      history_last_status='success',
      history_last_run_at=CURRENT_TIMESTAMP,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(monitorId);
}

function resetHistoryProgress(monitorId, pageNum = 1) {
  initDatabase();
  db.prepare(`
    UPDATE monitors SET
      history_next_page=?, history_completed=0,
      history_last_status=NULL, history_last_run_at=NULL,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(Number(pageNum), monitorId);
}

function getInitialHistoryPage(monitorId) {
  initDatabase();
  const monitor = getMonitor(monitorId);
  if (!monitor) throw new Error(`Monitor ${monitorId} 不存在`);

  if (monitor.history_next_page != null && Number(monitor.history_next_page) >= 1) {
    return Number(monitor.history_next_page);
  }

  const rows = db.prepare(`
    SELECT page_num,http_status,response_json,error_message,crawl_type
    FROM api_responses
    WHERE monitor_id=?
      AND COALESCE(crawl_type,'legacy') IN ('legacy','history')
    ORDER BY page_num DESC,id DESC
  `).all(monitorId);

  let maxSuccessfulPage = 0;
  for (const row of rows) {
    if (row.error_message && String(row.error_message).trim()) continue;
    if (!row.response_json) continue;
    if (row.http_status != null &&
        (Number(row.http_status) < 200 || Number(row.http_status) >= 300)) continue;
    try {
      const raw = JSON.parse(row.response_json);
      if (Number(raw?.code) !== 100000) continue;
      maxSuccessfulPage = Math.max(maxSuccessfulPage, Number(row.page_num) || 0);
    } catch {}
  }

  const nextPage = maxSuccessfulPage > 0 ? maxSuccessfulPage + 1 : 1;
  setHistoryNextPage(monitorId, nextPage);
  console.log(`Monitor ${monitorId} 初始化 History 断点：${nextPage}`);
  return nextPage;
}

function deleteMonitor(id) {
  initDatabase();
  db.prepare(`DELETE FROM monitors WHERE id=?`).run(id);
}

function normalizeNullable(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function saveComment(monitorId, comment) {
  initDatabase();

  const commentId = String(
    comment.comment_id ?? comment.commentId ?? comment.id ?? comment.cid ?? ''
  );
  if (!commentId) return false;

  const content = String(comment.content ?? comment.text ?? '');
  const commentTime = normalizeNullable(
    comment.comment_time ?? comment.commentTime ?? comment.time ?? null
  );
  const buyerNickname = normalizeNullable(
    comment.buyer_nickname ?? comment.buyerNickname ??
    comment.username ?? comment.user_nickname ?? null
  );
  const customerid = normalizeNullable(
    comment.customerid ?? comment.customer_id ?? comment.uid ?? comment.user_id ?? null
  );
  const skuName = normalizeNullable(
    comment.sku_name ?? comment.skuName ?? comment.product ?? null
  );

  db.prepare(`
    INSERT INTO comments(
      monitor_id,comment_id,buyer_nickname,customerid,sku_name,
      content,comment_time
    ) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(monitor_id,comment_id) DO UPDATE SET
      buyer_nickname=CASE
        WHEN comments.buyer_nickname IS NULL OR TRIM(comments.buyer_nickname)=''
        THEN excluded.buyer_nickname ELSE comments.buyer_nickname END,
      customerid=CASE
        WHEN comments.customerid IS NULL OR TRIM(comments.customerid)=''
        THEN excluded.customerid ELSE comments.customerid END,
      sku_name=CASE
        WHEN comments.sku_name IS NULL OR TRIM(comments.sku_name)=''
        THEN excluded.sku_name ELSE comments.sku_name END,
      comment_time=CASE
        WHEN comments.comment_time IS NULL OR TRIM(comments.comment_time)=''
        THEN excluded.comment_time ELSE comments.comment_time END,
      last_seen_at=CURRENT_TIMESTAMP
  `).run(
    monitorId, commentId, buyerNickname, customerid,
    skuName, content, commentTime
  );

  return true;
}

function saveComments(monitorId, comments) {
  initDatabase();
  let count = 0;
  db.exec('BEGIN');
  try {
    for (const comment of comments || []) {
      if (saveComment(monitorId, comment)) count++;
    }
    db.exec('COMMIT');
    return count;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const commentOrderSql = `
  CASE
    WHEN comment_time GLOB '[0-9]*'
    THEN CAST(comment_time AS INTEGER)
    ELSE 0
  END DESC,
  id DESC
`;

function getComments(monitorId, limit = 100) {
  initDatabase();
  return db.prepare(`
    SELECT * FROM comments
    WHERE monitor_id=?
    ORDER BY ${commentOrderSql}
    LIMIT ?
  `).all(monitorId, limit);
}

function getAllComments(monitorId = null) {
  initDatabase();
  if (monitorId !== null && monitorId !== undefined) {
    return db.prepare(`
      SELECT * FROM comments
      WHERE monitor_id=?
      ORDER BY ${commentOrderSql}
    `).all(monitorId);
  }
  return db.prepare(`
    SELECT * FROM comments ORDER BY ${commentOrderSql}
  `).all();
}

function getCommentIds(monitorId) {
  initDatabase();
  return new Set(
    db.prepare(`SELECT comment_id FROM comments WHERE monitor_id=?`)
      .all(monitorId)
      .map(row => String(row.comment_id))
  );
}

function saveApiResponse({
  monitorId, pageNum, apiUrl,
  httpStatus = null, responseData = null,
  errorMessage = null, crawlType = 'legacy'
}) {
  initDatabase();
  let responseJson = null;
  try {
    responseJson = responseData == null ? null : JSON.stringify(responseData);
  } catch (e) {
    responseJson = JSON.stringify({ serializationError: e.message });
  }

  const result = db.prepare(`
    INSERT INTO api_responses(
      monitor_id,page_num,api_url,http_status,response_json,error_message,crawl_type
    ) VALUES(?,?,?,?,?,?,?)
  `).run(
    monitorId, pageNum, apiUrl, httpStatus,
    responseJson, errorMessage, crawlType || 'legacy'
  );

  return Number(result.lastInsertRowid);
}

function getApiResponses(monitorId, limit = 500) {
  initDatabase();
  return db.prepare(`
    SELECT ar.*,m.name AS monitor_name
    FROM api_responses ar
    LEFT JOIN monitors m ON m.id=ar.monitor_id
    WHERE ar.monitor_id=?
    ORDER BY ar.id DESC LIMIT ?
  `).all(monitorId, limit);
}

function getAllApiResponses(limit = 500) {
  initDatabase();
  return db.prepare(`
    SELECT ar.*,m.name AS monitor_name
    FROM api_responses ar
    LEFT JOIN monitors m ON m.id=ar.monitor_id
    ORDER BY ar.id DESC LIMIT ?
  `).all(limit);
}

function getApiResponseById(id) {
  initDatabase();
  return db.prepare(`
    SELECT ar.*,m.name AS monitor_name
    FROM api_responses ar
    LEFT JOIN monitors m ON m.id=ar.monitor_id
    WHERE ar.id=?
  `).get(id);
}

function getLatestFailedApiResponse(monitorId, crawlType = null) {
  initDatabase();
  if (crawlType) {
    return db.prepare(`
      SELECT * FROM api_responses
      WHERE monitor_id=? AND crawl_type=?
        AND error_message IS NOT NULL AND TRIM(error_message)<>''
      ORDER BY id DESC LIMIT 1
    `).get(monitorId, crawlType);
  }
  return db.prepare(`
    SELECT * FROM api_responses
    WHERE monitor_id=?
      AND error_message IS NOT NULL AND TRIM(error_message)<>''
    ORDER BY id DESC LIMIT 1
  `).get(monitorId);
}

function getLatestApiResponse(monitorId, crawlType = null) {
  initDatabase();
  if (crawlType) {
    return db.prepare(`
      SELECT * FROM api_responses
      WHERE monitor_id=? AND crawl_type=?
      ORDER BY id DESC LIMIT 1
    `).get(monitorId, crawlType);
  }
  return db.prepare(`
    SELECT * FROM api_responses
    WHERE monitor_id=?
    ORDER BY id DESC LIMIT 1
  `).get(monitorId);
}

function saveDailyStats(monitorIdOrObject, maybeStats = null) {
  initDatabase();
  let monitorId, stats;

  if (
    typeof monitorIdOrObject === 'object' &&
    monitorIdOrObject !== null &&
    maybeStats === null
  ) {
    monitorId = Number(monitorIdOrObject.monitorId);
    stats = { ...monitorIdOrObject };
    delete stats.monitorId;
  } else {
    monitorId = Number(monitorIdOrObject);
    stats = maybeStats || {};
  }

  if (!monitorId) throw new Error('saveDailyStats 缺少 monitorId');

  const statDate = stats.statDate || new Date().toISOString().slice(0, 10);

  db.prepare(`
    INSERT INTO daily_stats(
      monitor_id,stat_date,total_comments,emoji_total,
      non_emoji_total,emoji_stats,text_stats
    ) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(monitor_id,stat_date) DO UPDATE SET
      total_comments=excluded.total_comments,
      emoji_total=excluded.emoji_total,
      non_emoji_total=excluded.non_emoji_total,
      emoji_stats=excluded.emoji_stats,
      text_stats=excluded.text_stats,
      updated_at=CURRENT_TIMESTAMP
  `).run(
    monitorId, statDate,
    stats.totalComments ?? 0,
    stats.emojiTotal ?? 0,
    stats.nonEmojiTotal ?? 0,
    JSON.stringify(stats.emojiStats || {}),
    JSON.stringify(stats.textStats || {})
  );
}

function getDailyStats(monitorId, limit = 30) {
  initDatabase();
  return db.prepare(`
    SELECT * FROM daily_stats
    WHERE monitor_id=?
    ORDER BY stat_date DESC
    LIMIT ?
  `).all(monitorId, limit);
}

function getMonitorResult(monitorId) {
  initDatabase();
  return db.prepare(`
    SELECT ds.*,m.name AS monitor_name
    FROM daily_stats ds
    LEFT JOIN monitors m ON m.id=ds.monitor_id
    WHERE ds.monitor_id=?
    ORDER BY ds.stat_date DESC
    LIMIT 1
  `).get(monitorId);
}

module.exports = {
  db, initDatabase,
  getMonitors, getMonitor, getMonitorByUrl,
  createMonitor, updateMonitor, updateMonitorStatus, deleteMonitor,
  updateLatestStatus, updateHistoryStatus, setHistoryNextPage,
  markHistoryCompleted, resetHistoryProgress, getInitialHistoryPage,
  saveComment, saveComments, getComments, getAllComments, getCommentIds,
  saveApiResponse, getApiResponses, getAllApiResponses, getApiResponseById,
  getLatestFailedApiResponse, getLatestApiResponse,
  saveDailyStats, getDailyStats, getMonitorResult,
  getSuperLikeMonitors,
  superLikePostIdExists,
  getExistingSuperLikeUids,
  isSuperLikeUser,
  getRecentSuperLikeProfileStatus,
  markSuperLikeProfileChecked,
  saveSuperLikeUser,
  saveSuperLikeTargetPost,
  deletePostsByUidSet,
  cleanupSuperLikePostsByUsersTable,
  getScanCheckpoint,
  saveScanCheckpoint,
  getScanResume,
  saveScanResume,
  clearScanResume
};
