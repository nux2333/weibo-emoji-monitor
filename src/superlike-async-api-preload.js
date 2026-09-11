'use strict';

/*
 * Web Server 专用：把最重的 GET /api/superlike-posts 从同步 DatabaseSync bridge
 * 切换到原生 pg.Pool。
 *
 * 这是一个 preload，必须在 server.js 之前加载。它只替换这个高频路由，
 * 其他历史 API 暂时仍可继续使用 postgres-preload，方便分阶段迁移。
 */

const express = require('express');
const { Pool, types } = require('pg');

const PATCHED = Symbol.for('weibo.superlike.async.api.patched');

// 与现有 postgres worker 保持一致：date/timestamp 不自动变成 JS Date，避免时区二次转换。
types.setTypeParser(1082, value => value);
types.setTypeParser(1114, value => value);

function requireDatabaseUrl() {
  const value = String(process.env.DATABASE_URL || '').trim();
  if (!value) {
    throw new Error('SuperLike async API 已启用，但 DATABASE_URL 未设置');
  }
  return value;
}

const pool = new Pool({
  connectionString: requireDatabaseUrl(),
  max: Math.max(2, Number(process.env.PG_WEB_POOL_MAX) || 20),
  idleTimeoutMillis: Math.max(5000, Number(process.env.PG_WEB_IDLE_TIMEOUT_MS) || 30000),
  connectionTimeoutMillis: Math.max(1000, Number(process.env.PG_WEB_CONNECT_TIMEOUT_MS) || 5000),
  allowExitOnIdle: false
});

pool.on('error', error => {
  console.error('[WebPG] idle client error:', error?.stack || error);
});

function addParam(params, value) {
  params.push(value);
  return `$${params.length}`;
}

function buildFilters(req) {
  const keyword = String(req.query.keyword || '').trim();
  const monitorId = req.query.monitorId ? Number(req.query.monitorId) : null;

  const movedFilter = ['all', 'moved', 'unmoved'].includes(
    String(req.query.moved || 'unmoved')
  )
    ? String(req.query.moved || 'unmoved')
    : 'unmoved';

  const todayOnly = String(req.query.todayOnly ?? '1') !== '0';
  const hideBlack = String(req.query.hideBlack ?? '1') !== '0';

  const where = [
    'sp.current_has_superlike = 0',
    'sp.comments_count < 22'
  ];
  const params = [];

  if (todayOnly) {
    // first_seen_at 现有数据按北京时间现值保存；不要再 +8。
    where.push(
      "CAST(sp.first_seen_at AS date) = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date"
    );
  }

  if (movedFilter === 'moved') {
    where.push('COALESCE(sp.moved_flag, 0) = 1');
  } else if (movedFilter === 'unmoved') {
    where.push('COALESCE(sp.moved_flag, 0) = 0');
  }

  if (Number.isFinite(monitorId) && monitorId > 0) {
    const p = addParam(params, monitorId);
    where.push(`sp.monitor_id = ${p}`);
  }

  if (keyword) {
    const p = addParam(params, `%${keyword}%`);
    where.push(`(
      CAST(sp.uid AS TEXT) ILIKE ${p}
      OR COALESCE(sp.username, '') ILIKE ${p}
      OR COALESCE(sp.post_text, '') ILIKE ${p}
      OR COALESCE(sp.icon_summary, '') ILIKE ${p}
    )`);
  }

  if (hideBlack) {
    where.push(`
      NOT EXISTS (
        SELECT 1
        FROM black_fan_users bfu
        WHERE TRIM(COALESCE(CAST(bfu.uid AS TEXT), '')) <> ''
          AND CAST(bfu.uid AS TEXT) = CAST(sp.uid AS TEXT)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM superlike_black_keywords bk
        WHERE bk.enabled = 1
          AND TRIM(COALESCE(bk.keyword, '')) <> ''
          AND (
            COALESCE(sp.username, '') ILIKE '%' || bk.keyword || '%'
            OR COALESCE(sp.post_text, '') ILIKE '%' || bk.keyword || '%'
            OR COALESCE(sp.icon_summary, '') ILIKE '%' || bk.keyword || '%'
          )
      )
    `);
  }

  return {
    whereSql: `WHERE ${where.join(' AND ')}`,
    params,
    movedFilter,
    todayOnly,
    hideBlack
  };
}

const commentsNeededCase = `
  CASE
    WHEN sp.initial_experience_7d IS NULL THEN NULL
    WHEN sp.initial_experience_7d >= 80 THEN 0
    WHEN COALESCE(sp.initial_comments_count, 0) < 5 THEN
      CASE
        WHEN sp.initial_experience_7d + 1 >= 80 THEN 5 - COALESCE(sp.initial_comments_count, 0)
        WHEN sp.initial_experience_7d + 3 >= 80 THEN 10 - COALESCE(sp.initial_comments_count, 0)
        WHEN sp.initial_experience_7d + 6 >= 80 THEN 15 - COALESCE(sp.initial_comments_count, 0)
        WHEN sp.initial_experience_7d + 10 >= 80 THEN 20 - COALESCE(sp.initial_comments_count, 0)
        ELSE -1
      END
    WHEN COALESCE(sp.initial_comments_count, 0) < 10 THEN
      CASE
        WHEN sp.initial_experience_7d + 2 >= 80 THEN 10 - COALESCE(sp.initial_comments_count, 0)
        WHEN sp.initial_experience_7d + 5 >= 80 THEN 15 - COALESCE(sp.initial_comments_count, 0)
        WHEN sp.initial_experience_7d + 9 >= 80 THEN 20 - COALESCE(sp.initial_comments_count, 0)
        ELSE -1
      END
    WHEN COALESCE(sp.initial_comments_count, 0) < 15 THEN
      CASE
        WHEN sp.initial_experience_7d + 3 >= 80 THEN 15 - COALESCE(sp.initial_comments_count, 0)
        WHEN sp.initial_experience_7d + 7 >= 80 THEN 20 - COALESCE(sp.initial_comments_count, 0)
        ELSE -1
      END
    WHEN COALESCE(sp.initial_comments_count, 0) < 20 THEN
      CASE
        WHEN sp.initial_experience_7d + 4 >= 80 THEN 20 - COALESCE(sp.initial_comments_count, 0)
        ELSE -1
      END
    ELSE -1
  END
`;

const sortScoreCase = `
  CASE
    WHEN sp.initial_experience_7d IS NULL THEN 999999
    WHEN sp.initial_experience_7d >= 80 THEN 0
    WHEN COALESCE(sp.initial_comments_count, 0) < 5 THEN
      CASE
        WHEN sp.initial_experience_7d + 1 >= 80 THEN 5 - COALESCE(sp.initial_comments_count, 0)
        WHEN sp.initial_experience_7d + 3 >= 80 THEN 10 - COALESCE(sp.initial_comments_count, 0)
        WHEN sp.initial_experience_7d + 6 >= 80 THEN 15 - COALESCE(sp.initial_comments_count, 0)
        WHEN sp.initial_experience_7d + 10 >= 80 THEN 20 - COALESCE(sp.initial_comments_count, 0)
        ELSE 999998
      END
    WHEN COALESCE(sp.initial_comments_count, 0) < 10 THEN
      CASE
        WHEN sp.initial_experience_7d + 2 >= 80 THEN 10 - COALESCE(sp.initial_comments_count, 0)
        WHEN sp.initial_experience_7d + 5 >= 80 THEN 15 - COALESCE(sp.initial_comments_count, 0)
        WHEN sp.initial_experience_7d + 9 >= 80 THEN 20 - COALESCE(sp.initial_comments_count, 0)
        ELSE 999998
      END
    WHEN COALESCE(sp.initial_comments_count, 0) < 15 THEN
      CASE
        WHEN sp.initial_experience_7d + 3 >= 80 THEN 15 - COALESCE(sp.initial_comments_count, 0)
        WHEN sp.initial_experience_7d + 7 >= 80 THEN 20 - COALESCE(sp.initial_comments_count, 0)
        ELSE 999998
      END
    WHEN COALESCE(sp.initial_comments_count, 0) < 20 THEN
      CASE
        WHEN sp.initial_experience_7d + 4 >= 80 THEN 20 - COALESCE(sp.initial_comments_count, 0)
        ELSE 999998
      END
    ELSE 999998
  END
`;

async function getSuperLikePosts(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
  res.setHeader('CDN-Cache-Control', 'no-store');

  const startedAt = Date.now();

  try {
    const {
      whereSql,
      params,
      movedFilter,
      todayOnly,
      hideBlack
    } = buildFilters(req);

    const listSql = `
      SELECT
        sp.id,
        sp.monitor_id,
        m.name AS monitor_name,
        sp.post_id,
        sp.uid,
        sp.username,
        sp.post_link,
        sp.post_text,
        sp.comments_count,
        sp.initial_comments_count,
        sp.current_has_superlike,
        sp.moved_flag,
        sp.icon_summary,
        sp.experience_7d,
        sp.initial_experience_7d,
        ${commentsNeededCase} AS comments_needed_for_80,
        sp.post_created_at,
        sp.inserted_at,
        sp.first_seen_at,
        sp.last_seen_at,
        sp.profile_status,
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM black_fan_users bfu
            WHERE TRIM(CAST(bfu.uid AS TEXT)) = TRIM(CAST(sp.uid AS TEXT))
          ) THEN 1 ELSE 0
        END AS black_fan_flg
      FROM superlike_posts sp
      LEFT JOIN monitors m ON m.id = sp.monitor_id
      ${whereSql}
      ORDER BY
        ${sortScoreCase} ASC,
        CASE WHEN sp.initial_experience_7d IS NULL THEN 1 ELSE 0 END ASC,
        sp.initial_experience_7d DESC,
        COALESCE(sp.initial_comments_count, 0) DESC,
        sp.post_created_at DESC NULLS LAST,
        sp.id DESC
      LIMIT 2000
    `;

    const statsSql = `
      SELECT
        COUNT(*) AS total,
        COUNT(DISTINCT sp.uid) AS user_count,
        SUM(CASE WHEN sp.experience_7d IS NOT NULL THEN 1 ELSE 0 END) AS experience_known
      FROM superlike_posts sp
      ${whereSql}
    `;

    // 同一个 HTTP 请求里的独立读查询并发发给 PostgreSQL，不再串行 Atomics.wait。
    const [listResult, statsResult, monitorsResult, keywordsResult, exitResult] =
      await Promise.all([
        pool.query(listSql, params),
        pool.query(statsSql, params),
        pool.query(`
          SELECT id, name
          FROM monitors
          WHERE enabled = 1 AND monitor_type = 'superlike'
          ORDER BY id
        `),
        pool.query(`
          SELECT keyword
          FROM superlike_black_keywords
          WHERE enabled = 1
          ORDER BY id
        `),
        pool.query(`
          SELECT COUNT(*) AS count
          FROM superlike_pool_exit_events
          WHERE exit_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::text
        `)
      ]);

    const stats = statsResult.rows[0] || {};
    const blackKeywords = keywordsResult.rows
      .map(row => String(row.keyword || ''))
      .filter(Boolean);

    const elapsedMs = Date.now() - startedAt;
    res.setHeader('Server-Timing', `pg;dur=${elapsedMs}`);
    res.setHeader('X-DB-Mode', 'async-pg-pool');

    if (elapsedMs >= 1000) {
      console.warn(
        `[WebPG][SLOW] GET /api/superlike-posts ${elapsedMs}ms | ` +
        `pool total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}`
      );
    }

    return res.json({
      success: true,
      stats: {
        total: Number(stats.total || 0),
        user_count: Number(stats.user_count || 0),
        today_became_superlike: Number(exitResult.rows[0]?.count || 0),
        experience_known: Number(stats.experience_known || 0)
      },
      filters: {
        hideBlack,
        todayOnly,
        moved: movedFilter,
        blackKeywords
      },
      monitors: monitorsResult.rows,
      data: listResult.rows
    });
  } catch (error) {
    console.error('[WebPG] 读取SuperLike候选失败：', error?.stack || error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
}

function install() {
  if (express.application[PATCHED]) return;

  const originalGet = express.application.get;

  express.application.get = function patchedGet(path, ...handlers) {
    if (path === '/api/superlike-posts') {
      console.log('[WebPG] /api/superlike-posts 已切换到原生 async pg.Pool');
      return originalGet.call(this, path, getSuperLikePosts);
    }
    return originalGet.call(this, path, ...handlers);
  };

  Object.defineProperty(express.application, PATCHED, {
    value: true,
    configurable: false,
    enumerable: false
  });

  console.log(
    '[WebPG] SuperLike async API preload 已启用' +
    ` | poolMax=${pool.options.max}`
  );
}

install();

module.exports = { pool, getSuperLikePosts };
