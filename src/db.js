const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR =
  path.join(
    __dirname,
    '..',
    'data'
  );

const DB_FILE =
  path.join(
    DATA_DIR,
    'monitor.db'
  );

fs.mkdirSync(
  DATA_DIR,
  {
    recursive: true
  }
);

console.log(
  'SQLite DB:',
  DB_FILE
);

const db =
  new DatabaseSync(
    DB_FILE
  );


function tableHasColumn(
  tableName,
  columnName
) {

  return db
    .prepare(
      `PRAGMA table_info(${tableName})`
    )
    .all()
    .some(
      row =>
        row.name ===
        columnName
    );
}


function ensureColumn(
  tableName,
  columnName,
  definition
) {

  if (
    tableHasColumn(
      tableName,
      columnName
    )
  ) {
    return;
  }

  db.exec(
    `ALTER TABLE ${tableName}
     ADD COLUMN ${columnName} ${definition}`
  );

  console.log(
    `数据库字段已补充：${tableName}.${columnName}`
  );
}


function initDatabase() {

  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS monitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      emojis TEXT NOT NULL DEFAULT '[]',
      texts TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_run_at TEXT,
      last_status TEXT
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      comment_id TEXT NOT NULL,
      buyer_nickname TEXT,
      sku_name TEXT,
      content TEXT NOT NULL,
      comment_time TEXT,
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(monitor_id, comment_id),
      FOREIGN KEY(monitor_id)
        REFERENCES monitors(id)
        ON DELETE CASCADE
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
      FOREIGN KEY(monitor_id)
        REFERENCES monitors(id)
        ON DELETE CASCADE
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
      FOREIGN KEY(monitor_id)
        REFERENCES monitors(id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS
      idx_comments_monitor
      ON comments(monitor_id);

    CREATE INDEX IF NOT EXISTS
      idx_comments_comment_id
      ON comments(comment_id);

    CREATE INDEX IF NOT EXISTS
      idx_comments_time
      ON comments(comment_time);

    CREATE INDEX IF NOT EXISTS
      idx_api_responses_page
      ON api_responses(monitor_id, page_num);

    CREATE INDEX IF NOT EXISTS
      idx_daily_stats_monitor_date
      ON daily_stats(monitor_id, stat_date);
  `);


  /**
   * 兼容已经存在的旧 monitor.db：
   * 不删表、不清数据，只补新字段。
   */
  ensureColumn(
    'comments',
    'buyer_nickname',
    'TEXT'
  );

  ensureColumn(
    'comments',
    'sku_name',
    'TEXT'
  );
}


function getMonitors(
  onlyEnabled = true
) {

  initDatabase();

  return onlyEnabled
    ? db.prepare(`
        SELECT *
        FROM monitors
        WHERE enabled = 1
        ORDER BY id
      `).all()
    : db.prepare(`
        SELECT *
        FROM monitors
        ORDER BY id
      `).all();
}


function getMonitor(id) {

  initDatabase();

  return db.prepare(`
    SELECT *
    FROM monitors
    WHERE id = ?
  `).get(id);
}


function getMonitorByUrl(url) {

  initDatabase();

  return db.prepare(`
    SELECT *
    FROM monitors
    WHERE url = ?
    LIMIT 1
  `).get(url);
}


function createMonitor({
  name,
  url,
  emojis = [],
  texts = [],
  enabled = true
}) {

  initDatabase();

  const result =
    db.prepare(`
      INSERT INTO monitors(
        name,
        url,
        emojis,
        texts,
        enabled
      )
      VALUES(?,?,?,?,?)
    `).run(
      name,
      url,
      JSON.stringify(emojis),
      JSON.stringify(texts),
      enabled ? 1 : 0
    );

  return Number(
    result.lastInsertRowid
  );
}


function updateMonitor(
  id,
  {
    name,
    url,
    emojis = [],
    texts = [],
    enabled = true
  }
) {

  initDatabase();

  db.prepare(`
    UPDATE monitors
    SET
      name = ?,
      url = ?,
      emojis = ?,
      texts = ?,
      enabled = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    name,
    url,
    JSON.stringify(emojis),
    JSON.stringify(texts),
    enabled ? 1 : 0,
    id
  );
}


function updateMonitorStatus(
  id,
  status
) {

  initDatabase();

  db.prepare(`
    UPDATE monitors
    SET
      last_status = ?,
      last_run_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    status,
    id
  );
}


function deleteMonitor(id) {

  initDatabase();

  db.prepare(`
    DELETE FROM monitors
    WHERE id = ?
  `).run(id);
}


function saveComment(
  monitorId,
  comment
) {

  initDatabase();

  const commentId =
    String(
      comment.comment_id ??
      comment.commentId ??
      comment.id ??
      comment.cid ??
      ''
    );

  if (!commentId) {
    return false;
  }

  const content =
    String(
      comment.content ??
      comment.text ??
      ''
    );

  const commentTime =
    comment.comment_time ??
    comment.commentTime ??
    comment.time ??
    null;

  const buyerNickname =
    comment.buyer_nickname ??
    comment.buyerNickname ??
    comment.username ??
    null;

  const skuName =
    comment.sku_name ??
    comment.skuName ??
    comment.product ??
    null;

  db.prepare(`
    INSERT OR IGNORE INTO comments(
      monitor_id,
      comment_id,
      buyer_nickname,
      sku_name,
      content,
      comment_time
    )
    VALUES(?,?,?,?,?,?)
  `).run(
    monitorId,
    commentId,
    buyerNickname,
    skuName,
    content,
    commentTime == null
      ? null
      : String(commentTime)
  );

  return true;
}


function saveComments(
  monitorId,
  comments
) {

  initDatabase();

  let count = 0;

  db.exec('BEGIN');

  try {

    for (
      const comment
      of comments || []
    ) {

      if (
        saveComment(
          monitorId,
          comment
        )
      ) {
        count++;
      }
    }

    db.exec('COMMIT');

    return count;

  } catch (error) {

    db.exec('ROLLBACK');

    throw error;
  }
}


function getComments(
  monitorId,
  limit = 100
) {

  initDatabase();

  return db.prepare(`
    SELECT *
    FROM comments
    WHERE monitor_id = ?
    ORDER BY
      CASE
        WHEN comment_time GLOB '[0-9]*'
        THEN CAST(comment_time AS INTEGER)
        ELSE 0
      END DESC,
      id DESC
    LIMIT ?
  `).all(
    monitorId,
    limit
  );
}


function getAllComments() {

  initDatabase();

  return db.prepare(`
    SELECT *
    FROM comments
    ORDER BY
      CASE
        WHEN comment_time GLOB '[0-9]*'
        THEN CAST(comment_time AS INTEGER)
        ELSE 0
      END DESC,
      id DESC
  `).all();
}


function getCommentIds(
  monitorId
) {

  initDatabase();

  return new Set(
    db.prepare(`
      SELECT comment_id
      FROM comments
      WHERE monitor_id = ?
    `)
      .all(
        monitorId
      )
      .map(
        row =>
          String(
            row.comment_id
          )
      )
  );
}


function saveApiResponse({
  monitorId,
  pageNum,
  apiUrl,
  httpStatus = null,
  responseData = null,
  errorMessage = null
}) {

  initDatabase();

  let responseJson = null;

  try {

    responseJson =
      responseData == null
        ? null
        : JSON.stringify(
            responseData
          );

  } catch (error) {

    responseJson =
      JSON.stringify({
        serializationError:
          error.message
      });
  }

  db.prepare(`
    INSERT INTO api_responses(
      monitor_id,
      page_num,
      api_url,
      http_status,
      response_json,
      error_message
    )
    VALUES(?,?,?,?,?,?)
  `).run(
    monitorId,
    pageNum,
    apiUrl,
    httpStatus,
    responseJson,
    errorMessage
  );
}


function getApiResponses(
  monitorId,
  limit = 500
) {

  initDatabase();

  return db.prepare(`
    SELECT
      ar.*,
      m.name AS monitor_name
    FROM api_responses ar
    LEFT JOIN monitors m
      ON m.id = ar.monitor_id
    WHERE ar.monitor_id = ?
    ORDER BY ar.id DESC
    LIMIT ?
  `).all(
    monitorId,
    limit
  );
}


function getAllApiResponses(
  limit = 500
) {

  initDatabase();

  return db.prepare(`
    SELECT
      ar.*,
      m.name AS monitor_name
    FROM api_responses ar
    LEFT JOIN monitors m
      ON m.id = ar.monitor_id
    ORDER BY ar.id DESC
    LIMIT ?
  `).all(
    limit
  );
}


function getApiResponseById(id) {

  initDatabase();

  return db.prepare(`
    SELECT
      ar.*,
      m.name AS monitor_name
    FROM api_responses ar
    LEFT JOIN monitors m
      ON m.id = ar.monitor_id
    WHERE ar.id = ?
  `).get(id);
}


function getLatestFailedApiResponse(
  monitorId
) {

  initDatabase();

  return db.prepare(`
    SELECT *
    FROM api_responses
    WHERE monitor_id = ?
      AND error_message IS NOT NULL
      AND TRIM(error_message) <> ''
    ORDER BY id DESC
    LIMIT 1
  `).get(
    monitorId
  );
}


function getLatestApiResponse(
  monitorId
) {

  initDatabase();

  return db.prepare(`
    SELECT *
    FROM api_responses
    WHERE monitor_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(
    monitorId
  );
}


function saveDailyStats(
  monitorId,
  stats
) {

  initDatabase();

  const statDate =
    stats.statDate ||
    new Date()
      .toISOString()
      .slice(0, 10);

  db.prepare(`
    INSERT INTO daily_stats(
      monitor_id,
      stat_date,
      total_comments,
      emoji_total,
      non_emoji_total,
      emoji_stats,
      text_stats
    )
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(
      monitor_id,
      stat_date
    )
    DO UPDATE SET
      total_comments = excluded.total_comments,
      emoji_total = excluded.emoji_total,
      non_emoji_total = excluded.non_emoji_total,
      emoji_stats = excluded.emoji_stats,
      text_stats = excluded.text_stats,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    monitorId,
    statDate,
    stats.totalComments ?? 0,
    stats.emojiTotal ?? 0,
    stats.nonEmojiTotal ?? 0,
    JSON.stringify(
      stats.emojiStats || {}
    ),
    JSON.stringify(
      stats.textStats || {}
    )
  );
}


function getDailyStats(
  monitorId,
  limit = 30
) {

  initDatabase();

  return db.prepare(`
    SELECT *
    FROM daily_stats
    WHERE monitor_id = ?
    ORDER BY stat_date DESC
    LIMIT ?
  `).all(
    monitorId,
    limit
  );
}


function getMonitorResult(
  monitorId
) {

  initDatabase();

  return db.prepare(`
    SELECT
      ds.*,
      m.name AS monitor_name
    FROM daily_stats ds
    LEFT JOIN monitors m
      ON m.id = ds.monitor_id
    WHERE ds.monitor_id = ?
    ORDER BY ds.stat_date DESC
    LIMIT 1
  `).get(
    monitorId
  );
}


module.exports = {
  db,
  initDatabase,
  getMonitors,
  getMonitor,
  getMonitorByUrl,
  createMonitor,
  updateMonitor,
  updateMonitorStatus,
  deleteMonitor,
  saveComment,
  saveComments,
  getComments,
  getAllComments,
  getCommentIds,
  saveApiResponse,
  getApiResponses,
  getAllApiResponses,
  getApiResponseById,
  getLatestFailedApiResponse,
  getLatestApiResponse,
  saveDailyStats,
  getDailyStats,
  getMonitorResult
};
