'use strict';

/*
 * Web Server 专用：把 SuperLike 页面写接口 + SSE 从同步 DatabaseSync bridge
 * 切到原生 async pg.Pool。
 *
 * 与 superlike-async-api-preload.js 共用独立 pg.Pool 思路，但本文件自己维护
 * 一个轻量连接池，避免依赖 preload 加载顺序/模块内部实现。
 */

const express = require('express');
const { Pool, types } = require('pg');

const PATCHED = Symbol.for('weibo.superlike.async.write.api.patched');

types.setTypeParser(1082, value => value);
types.setTypeParser(1114, value => value);

function requireDatabaseUrl() {
  const value = String(process.env.DATABASE_URL || '').trim();
  if (!value) throw new Error('SuperLike async write API 已启用，但 DATABASE_URL 未设置');
  return value;
}

const pool = new Pool({
  connectionString: requireDatabaseUrl(),
  max: Math.max(2, Number(process.env.PG_WEB_WRITE_POOL_MAX) || 10),
  idleTimeoutMillis: Math.max(5000, Number(process.env.PG_WEB_IDLE_TIMEOUT_MS) || 30000),
  connectionTimeoutMillis: Math.max(1000, Number(process.env.PG_WEB_CONNECT_TIMEOUT_MS) || 5000),
  allowExitOnIdle: false
});

pool.on('error', error => {
  console.error('[WebPG-Write] idle client error:', error?.stack || error);
});

const eventClients = new Set();

function sendDbMode(res, startedAt) {
  const elapsedMs = Date.now() - startedAt;
  res.setHeader('X-DB-Mode', 'async-pg-pool');
  res.setHeader('Server-Timing', `pg;dur=${elapsedMs}`);
  if (elapsedMs >= 1000) {
    console.warn(
      `[WebPG-Write][SLOW] ${elapsedMs}ms | pool total=${pool.totalCount} ` +
      `idle=${pool.idleCount} waiting=${pool.waitingCount}`
    );
  }
}

function broadcast(eventName, data = {}) {
  const safe = String(eventName || '').trim().replace(/[^a-z0-9_-]/gi, '');
  if (!safe) return;
  const payload = JSON.stringify({ type: safe, ...data, ts: Date.now() });
  for (const res of eventClients) {
    try {
      res.write(`event: ${safe}\ndata: ${payload}\n\n`);
    } catch {
      eventClients.delete(res);
    }
  }
}

function broadcastMoved(ids, moved = true) {
  const normalized = Array.from(new Set((ids || [])
    .map(Number)
    .filter(id => Number.isFinite(id) && id > 0)));
  if (!normalized.length) return;
  broadcast('moved', { ids: normalized, moved: moved === true });
}

function eventsHandler(req, res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  eventClients.add(res);
  res.write('event: connected\ndata: {"ok":true}\n\n');

  const heartbeat = setInterval(() => {
    try { res.write(': keepalive\n\n'); }
    catch { clearInterval(heartbeat); eventClients.delete(res); }
  }, 20000);
  heartbeat.unref?.();

  req.on('close', () => {
    clearInterval(heartbeat);
    eventClients.delete(res);
  });
}

async function moveIntentHandler(req, res) {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const normalized = Array.from(new Set(ids.map(Number)
    .filter(id => Number.isFinite(id) && id > 0)));
  if (!normalized.length) return res.status(400).json({ success: false, message: '没有有效的帖子ID' });
  if (normalized.length > 200) return res.status(400).json({ success: false, message: '一次最多广播200条' });
  broadcastMoved(normalized, true);
  return res.json({ success: true, ids: normalized });
}

async function markUserHandler(req, res) {
  const startedAt = Date.now();
  const monitorId = Number(req.body?.monitorId);
  const uid = String(req.body?.uid || '').trim();
  if (!Number.isFinite(monitorId) || monitorId <= 0 || !/^\d+$/.test(uid)) {
    return res.status(400).json({ success: false, message: 'monitorId 或 UID 无效' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const insertedResult = await client.query(`
      INSERT INTO superlike_users(monitor_id, uid, scan_date)
      VALUES($1, $2, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::text)
      ON CONFLICT(uid) DO NOTHING
      RETURNING uid
    `, [monitorId, uid]);

    const deletedResult = await client.query(
      'DELETE FROM superlike_posts WHERE CAST(uid AS TEXT) = $1 RETURNING id',
      [uid]
    );

    const deleted = deletedResult.rowCount || 0;
    if (deleted > 0) {
      await client.query(`
        INSERT INTO superlike_pool_exit_events(monitor_id, uid, exit_date, reason, exited_at)
        VALUES($1, $2, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::text,
               'BECAME_SUPERLIKE', CURRENT_TIMESTAMP)
      `, [monitorId, uid]);
    }

    await client.query('COMMIT');

    broadcast('user_removed', { uid, reason: 'SUPERLIKE' });
    sendDbMode(res, startedAt);
    return res.json({
      success: true,
      uid,
      inserted: insertedResult.rowCount > 0,
      deleted
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[WebPG-Write][人工确认] 失败：', error?.stack || error);
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
}

async function blackFanHandler(req, res) {
  const startedAt = Date.now();
  const uid = String(req.body?.uid || '').trim();
  const username = String(req.body?.username || '').trim();
  if (!/^\d+$/.test(uid)) {
    return res.status(400).json({ success: false, message: 'UID 无效' });
  }
  const profileLink = 'https://m.weibo.cn/u/' + encodeURIComponent(uid);
  try {
    const result = await pool.query(`
      INSERT INTO black_fan_users(uid, username, profile_link)
      VALUES($1, $2, $3)
      ON CONFLICT(uid) DO UPDATE SET
        username = EXCLUDED.username,
        profile_link = EXCLUDED.profile_link
      RETURNING uid
    `, [uid, username || null, profileLink]);

    broadcast('black_fan', { uid, username: username || '' });
    sendDbMode(res, startedAt);
    return res.json({ success: true, uid, inserted: result.rowCount > 0 });
  } catch (error) {
    console.error('[WebPG-Write][BlackFan] 失败：', error?.stack || error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function postMovedHandler(req, res) {
  const startedAt = Date.now();
  const id = Number(req.body?.id);
  const moved = req.body?.moved === true;
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ success: false, message: '帖子ID无效' });
  }
  try {
    const result = await pool.query(
      'UPDATE superlike_posts SET moved_flag = $1 WHERE id = $2 RETURNING id',
      [moved ? 1 : 0, id]
    );
    if (!result.rowCount) {
      return res.status(404).json({ success: false, message: '帖子不存在或已被删除' });
    }
    broadcastMoved([id], moved);
    sendDbMode(res, startedAt);
    return res.json({ success: true, id, moved_flag: moved ? 1 : 0 });
  } catch (error) {
    console.error('[WebPG-Write][搬运状态] 失败：', error?.stack || error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function postsMovedHandler(req, res) {
  const startedAt = Date.now();
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const normalized = Array.from(new Set(ids.map(Number)
    .filter(id => Number.isFinite(id) && id > 0)));
  if (!normalized.length) return res.status(400).json({ success: false, message: '没有有效的帖子ID' });
  if (normalized.length > 2000) return res.status(400).json({ success: false, message: '一次最多处理2000条帖子' });

  try {
    const result = await pool.query(
      'UPDATE superlike_posts SET moved_flag = 1 WHERE id = ANY($1::bigint[]) RETURNING id',
      [normalized]
    );
    broadcastMoved(normalized, true);
    sendDbMode(res, startedAt);
    return res.json({ success: true, changed: result.rowCount || 0, moved_flag: 1 });
  } catch (error) {
    console.error('[WebPG-Write][批量搬运] 失败：', error?.stack || error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

function install() {
  if (express.application[PATCHED]) return;

  const originalGet = express.application.get;
  const originalPost = express.application.post;

  express.application.get = function patchedGet(path, ...handlers) {
    if (path === '/api/superlike-events') {
      console.log('[WebPG-Write] /api/superlike-events 已切换到 async 模块 SSE');
      return originalGet.call(this, path, eventsHandler);
    }
    return originalGet.call(this, path, ...handlers);
  };

  const handlers = new Map([
    ['/api/superlike-move-intent', moveIntentHandler],
    ['/api/superlike-mark-user', markUserHandler],
    ['/api/black-fan-user', blackFanHandler],
    ['/api/superlike-post-moved', postMovedHandler],
    ['/api/superlike-posts-moved', postsMovedHandler]
  ]);

  express.application.post = function patchedPost(path, ...routeHandlers) {
    const replacement = handlers.get(path);
    if (replacement) {
      console.log(`[WebPG-Write] ${path} 已切换到原生 async pg.Pool`);
      return originalPost.call(this, path, replacement);
    }
    return originalPost.call(this, path, ...routeHandlers);
  };

  Object.defineProperty(express.application, PATCHED, {
    value: true,
    configurable: false,
    enumerable: false
  });

  console.log(
    '[WebPG-Write] SuperLike async write API preload 已启用' +
    ` | poolMax=${pool.options.max}`
  );
}

install();

module.exports = { pool, broadcast, broadcastMoved };
