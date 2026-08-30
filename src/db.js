const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'monitor.db');
const db = new DatabaseSync(DB_FILE);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`数据库迁移：${table}.${column} 已添加`);
  }
}

function initDatabase() {
  db.exec(`
    PRAGMA journal_mode = WAL;
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
      content TEXT NOT NULL,
      comment_time TEXT,
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(monitor_id, comment_id),
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS daily_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      stat_date TEXT NOT NULL,
      total_comments INTEGER NOT NULL DEFAULT 0,
      matched_comments INTEGER NOT NULL DEFAULT 0,
      unmatched_comments INTEGER NOT NULL DEFAULT 0,
      emoji_total INTEGER NOT NULL DEFAULT 0,
      text_total INTEGER NOT NULL DEFAULT 0,
      emoji_stats TEXT NOT NULL DEFAULT '{}',
      text_stats TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(monitor_id, stat_date),
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
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_comments_monitor ON comments(monitor_id);
    CREATE INDEX IF NOT EXISTS idx_comments_comment_id ON comments(comment_id);
    CREATE INDEX IF NOT EXISTS idx_daily_stats_monitor ON daily_stats(monitor_id);
    CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(stat_date);
    CREATE INDEX IF NOT EXISTS idx_api_responses_monitor ON api_responses(monitor_id);
    CREATE INDEX IF NOT EXISTS idx_api_responses_page ON api_responses(monitor_id, page_num);
  `);

  // 关键：CREATE TABLE IF NOT EXISTS 不会修改旧 DB 的表结构。
  // 因此即使你已经有 monitor.db，也会自动补 error_message。
  ensureColumn('api_responses', 'error_message', 'TEXT');
  console.log(`SQLite DB: ${DB_FILE}`);
}

function getMonitors(onlyEnabled = false) {
  let sql = 'SELECT * FROM monitors';
  if (onlyEnabled) sql += ' WHERE enabled = 1';
  sql += ' ORDER BY id ASC';
  return db.prepare(sql).all();
}
function getMonitor(id) { return db.prepare('SELECT * FROM monitors WHERE id = ?').get(id); }
function getMonitorByUrl(url) { return db.prepare('SELECT * FROM monitors WHERE url = ? LIMIT 1').get(url); }
function createMonitor({ name, url, emojis = [], texts = [], enabled = true }) {
  const r = db.prepare(`INSERT INTO monitors(name,url,emojis,texts,enabled) VALUES(?,?,?,?,?)`).run(name,url,JSON.stringify(emojis),JSON.stringify(texts),enabled ? 1 : 0);
  return Number(r.lastInsertRowid);
}
function updateMonitor(id, { name, url, emojis = [], texts = [], enabled = true }) {
  db.prepare(`UPDATE monitors SET name=?,url=?,emojis=?,texts=?,enabled=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(name,url,JSON.stringify(emojis),JSON.stringify(texts),enabled ? 1 : 0,id);
}
function updateMonitorStatus(id, status) {
  db.prepare(`UPDATE monitors SET last_run_at=CURRENT_TIMESTAMP,last_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(status,id);
}
function deleteMonitor(id) { db.prepare('DELETE FROM monitors WHERE id = ?').run(id); }

function saveComment({ monitorId, commentId, content, commentTime = null }) {
  db.prepare(`
    INSERT INTO comments(monitor_id,comment_id,content,comment_time)
    VALUES(?,?,?,?)
    ON CONFLICT(monitor_id,comment_id) DO UPDATE SET
      content=excluded.content,
      comment_time=excluded.comment_time,
      last_seen_at=CURRENT_TIMESTAMP
  `).run(monitorId,String(commentId),content || '',commentTime);
}
function saveComments(monitorId, comments) {
  const stmt = db.prepare(`
    INSERT INTO comments(monitor_id,comment_id,content,comment_time)
    VALUES(?,?,?,?)
    ON CONFLICT(monitor_id,comment_id) DO UPDATE SET
      content=excluded.content,
      comment_time=excluded.comment_time,
      last_seen_at=CURRENT_TIMESTAMP
  `);
  for (const c of comments || []) {
    if (c?.commentId == null || !c?.content) continue;
    stmt.run(monitorId,String(c.commentId),String(c.content),c.commentTime || null);
  }
}
function getComments(monitorId, limit=100) {
  return db.prepare(`SELECT comment_id,content,comment_time,first_seen_at,last_seen_at FROM comments WHERE monitor_id=? ORDER BY COALESCE(comment_time,first_seen_at) DESC LIMIT ?`).all(monitorId,limit);
}
function getAllComments(monitorId) {
  return db.prepare(`SELECT comment_id,content,comment_time,first_seen_at,last_seen_at FROM comments WHERE monitor_id=? ORDER BY COALESCE(comment_time,first_seen_at) ASC`).all(monitorId);
}
function getCommentIds(monitorId) {
  return new Set(db.prepare('SELECT comment_id FROM comments WHERE monitor_id=?').all(monitorId).map(r => String(r.comment_id)));
}

function saveApiResponse({ monitorId, pageNum, apiUrl, httpStatus=null, responseData=null, errorMessage=null }) {
  initDatabase();
  let responseJson = null;
  try { responseJson = responseData == null ? null : JSON.stringify(responseData); }
  catch (e) { responseJson = JSON.stringify({ serializationError: e.message }); }
  db.prepare(`
    INSERT INTO api_responses(monitor_id,page_num,api_url,http_status,response_json,error_message)
    VALUES(?,?,?,?,?,?)
  `).run(monitorId,pageNum,apiUrl,httpStatus,responseJson,errorMessage);
}
function getApiResponses(monitorId, limit=200) {
  return db.prepare(`
    SELECT a.*, m.name AS monitor_name
    FROM api_responses a JOIN monitors m ON m.id=a.monitor_id
    WHERE a.monitor_id=? ORDER BY a.id DESC LIMIT ?
  `).all(monitorId,limit);
}
function getAllApiResponses(limit=500) {
  return db.prepare(`
    SELECT a.*, m.name AS monitor_name
    FROM api_responses a JOIN monitors m ON m.id=a.monitor_id
    ORDER BY a.id DESC LIMIT ?
  `).all(limit);
}
function getApiResponseById(id) {
  return db.prepare(`
    SELECT a.*, m.name AS monitor_name
    FROM api_responses a JOIN monitors m ON m.id=a.monitor_id
    WHERE a.id=?
  `).get(id);
}
function getLatestFailedApiResponse(monitorId) {
  return db.prepare(`
    SELECT * FROM api_responses
    WHERE monitor_id=? AND (error_message IS NOT NULL AND TRIM(error_message) <> '')
    ORDER BY id DESC LIMIT 1
  `).get(monitorId);
}
function getLatestApiResponse(monitorId,pageNum) {
  return db.prepare(`SELECT * FROM api_responses WHERE monitor_id=? AND page_num=? ORDER BY id DESC LIMIT 1`).get(monitorId,pageNum);
}

function saveDailyStats({ monitorId, statDate, totalComments, matchedComments, unmatchedComments, emojiTotal, textTotal, emojiStats, textStats }) {
  db.prepare(`
    INSERT INTO daily_stats(monitor_id,stat_date,total_comments,matched_comments,unmatched_comments,emoji_total,text_total,emoji_stats,text_stats)
    VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(monitor_id,stat_date) DO UPDATE SET
      total_comments=excluded.total_comments,
      matched_comments=excluded.matched_comments,
      unmatched_comments=excluded.unmatched_comments,
      emoji_total=excluded.emoji_total,
      text_total=excluded.text_total,
      emoji_stats=excluded.emoji_stats,
      text_stats=excluded.text_stats
  `).run(monitorId,statDate,totalComments,matchedComments,unmatchedComments,emojiTotal,textTotal,JSON.stringify(emojiStats),JSON.stringify(textStats));
}
function getDailyStats(monitorId,limit=30) { return db.prepare('SELECT * FROM daily_stats WHERE monitor_id=? ORDER BY stat_date DESC LIMIT ?').all(monitorId,limit); }
function getMonitorResult(monitorId) {
  return db.prepare(`SELECT d.*,m.name,m.url,m.emojis,m.texts FROM daily_stats d JOIN monitors m ON m.id=d.monitor_id WHERE d.monitor_id=? ORDER BY d.stat_date DESC LIMIT 1`).get(monitorId);
}

module.exports = {
  db, initDatabase, getMonitors, getMonitor, getMonitorByUrl, createMonitor, updateMonitor,
  updateMonitorStatus, deleteMonitor, saveComment, saveComments, getComments, getAllComments,
  getCommentIds, saveApiResponse, getApiResponses, getAllApiResponses, getApiResponseById,
  getLatestFailedApiResponse, getLatestApiResponse, saveDailyStats, getDailyStats, getMonitorResult
};
