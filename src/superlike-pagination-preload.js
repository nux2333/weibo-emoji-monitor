const fs = require('fs');
const path = require('path');
const express = require('express');
const {
  db,
  getTodaySuperLikePoolExitCount
} = require('./db');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SUPERLIKE_JS = path.join(PUBLIC_DIR, 'superlike.js');
const PAGINATION_OVERRIDE_JS = path.join(PUBLIC_DIR, 'superlike-pagination.js');

const COMMENTS_NEEDED_EXPR = `
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

function getOrderBy(sortKey, sortDirection) {
  const direction = sortDirection === 'asc' ? 'ASC' : 'DESC';

  switch (sortKey) {
    case 'post_created_at':
      return `
        CASE WHEN sp.post_created_at IS NULL THEN 1 ELSE 0 END ASC,
        datetime(sp.post_created_at) ${direction},
        sp.id ${direction}
      `;

    case 'comments_count':
      return `
        COALESCE(sp.comments_count, 0) ${direction},
        datetime(sp.post_created_at) DESC,
        sp.id DESC
      `;

    case 'comments_needed_for_80':
      return `
        CASE WHEN (${COMMENTS_NEEDED_EXPR}) IS NULL THEN 1 ELSE 0 END ASC,
        (${COMMENTS_NEEDED_EXPR}) ${direction},
        datetime(sp.post_created_at) DESC,
        sp.id DESC
      `;

    case 'experience_7d':
    default:
      return `
        CASE WHEN sp.experience_7d IS NULL THEN 1 ELSE 0 END ASC,
        sp.experience_7d ${direction},
        datetime(sp.post_created_at) DESC,
        sp.id DESC
      `;
  }
}

function superLikePostsHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
  res.setHeader('CDN-Cache-Control', 'no-store');

  try {
    const keyword = String(req.query.keyword || '').trim();
    const monitorId = req.query.monitorId ? Number(req.query.monitorId) : null;
    const movedFilter = ['all', 'moved', 'unmoved'].includes(String(req.query.moved || 'unmoved'))
      ? String(req.query.moved || 'unmoved')
      : 'unmoved';
    const todayOnly = String(req.query.todayOnly ?? '1') !== '0';
    const hideBlack = String(req.query.hideBlack ?? '1') !== '0';

    const requestedPage = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(20, Number(req.query.pageSize) || 50));
    const sortKey = ['post_created_at', 'comments_count', 'experience_7d', 'comments_needed_for_80']
      .includes(String(req.query.sortKey || 'experience_7d'))
      ? String(req.query.sortKey || 'experience_7d')
      : 'experience_7d';
    const sortDirection = String(req.query.sortDirection || 'desc').toLowerCase() === 'asc'
      ? 'asc'
      : 'desc';

    const where = [
      'sp.current_has_superlike = 0',
      'sp.comments_count < 22'
    ];
    const params = [];

    if (todayOnly) {
      /*
       * first_seen_at 已经按北京时间(+08:00)落库，不能再 +8 小时。
       * 旧逻辑在 16:00 之后会把当天记录推到“次日”，导致新帖被误过滤。
       */
      where.push("date(sp.first_seen_at) = date('now', '+8 hours')");
    }

    if (movedFilter === 'moved') {
      where.push('COALESCE(sp.moved_flag, 0) = 1');
    } else if (movedFilter === 'unmoved') {
      where.push('COALESCE(sp.moved_flag, 0) = 0');
    }

    if (monitorId) {
      where.push('sp.monitor_id = ?');
      params.push(monitorId);
    }

    if (keyword) {
      where.push(`(
        sp.uid LIKE ?
        OR sp.username LIKE ?
        OR sp.post_text LIKE ?
        OR sp.icon_summary LIKE ?
      )`);
      const p = `%${keyword}%`;
      params.push(p, p, p, p);
    }

    if (hideBlack) {
      where.push(`
        NOT EXISTS (
          SELECT 1
          FROM black_fan_users bfu
          WHERE TRIM(COALESCE(bfu.uid, '')) <> ''
            AND CAST(bfu.uid AS TEXT) = CAST(sp.uid AS TEXT)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM superlike_black_keywords bk
          WHERE bk.enabled = 1
            AND TRIM(COALESCE(bk.keyword, '')) <> ''
            AND (
              LOWER(COALESCE(sp.username, '')) LIKE '%' || LOWER(bk.keyword) || '%'
              OR LOWER(COALESCE(sp.post_text, '')) LIKE '%' || LOWER(bk.keyword) || '%'
              OR LOWER(COALESCE(sp.icon_summary, '')) LIKE '%' || LOWER(bk.keyword) || '%'
            )
        )
      `);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;

    const stats = db.prepare(`
      SELECT
        COUNT(*) AS total,
        COUNT(DISTINCT sp.uid) AS user_count,
        SUM(CASE WHEN sp.experience_7d IS NOT NULL THEN 1 ELSE 0 END) AS experience_known
      FROM superlike_posts sp
      ${whereSql}
    `).get(...params);

    const total = Number(stats?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * pageSize;
    const orderBy = getOrderBy(sortKey, sortDirection);

    const data = db.prepare(`
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
        ${COMMENTS_NEEDED_EXPR} AS comments_needed_for_80,
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
          ) THEN 1
          ELSE 0
        END AS black_fan_flg
      FROM superlike_posts sp
      LEFT JOIN monitors m ON m.id = sp.monitor_id
      ${whereSql}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    const monitors = db.prepare(`
      SELECT id,name
      FROM monitors
      WHERE enabled=1 AND monitor_type='superlike'
      ORDER BY id
    `).all();

    const blackKeywords = db.prepare(`
      SELECT keyword
      FROM superlike_black_keywords
      WHERE enabled = 1
      ORDER BY id
    `).all()
      .map(row => String(row.keyword || ''))
      .filter(Boolean);

    res.json({
      success: true,
      stats: {
        total,
        user_count: Number(stats?.user_count || 0),
        today_became_superlike: getTodaySuperLikePoolExitCount(),
        experience_known: Number(stats?.experience_known || 0)
      },
      filters: {
        hideBlack,
        todayOnly,
        moved: movedFilter,
        blackKeywords
      },
      sorting: {
        sortKey,
        sortDirection
      },
      pagination: {
        page,
        pageSize,
        total,
        totalPages
      },
      monitors,
      data
    });
  } catch (error) {
    console.error('[SuperLike分页] 读取候选失败：', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
}

/*
 * server.js 仍保留原路由源码；这里只在 Express 注册阶段替换
 * /api/superlike-posts 的 GET handler，避免大范围改动 server.js。
 */
const originalGet = express.application.get;
express.application.get = function patchedGet(routePath, ...handlers) {
  if (routePath === '/api/superlike-posts') {
    return originalGet.call(this, routePath, superLikePostsHandler);
  }
  return originalGet.call(this, routePath, ...handlers);
};

/*
 * 动态给现有 superlike.js 追加分页覆盖逻辑。
 * 同时移除旧脚本启动时的首次全量 loadData，避免页面打开先拉2000条。
 */
const originalStatic = express.static;
express.static = function patchedStatic(root, options) {
  const middleware = originalStatic(root, options);
  const resolvedRoot = path.resolve(root);

  return function superLikeStatic(req, res, next) {
    const pathname = String(req.path || req.url || '').split('?')[0];

    if (resolvedRoot === path.resolve(PUBLIC_DIR) && pathname === '/superlike.js') {
      try {
        let source = fs.readFileSync(SUPERLIKE_JS, 'utf8');
        const override = fs.readFileSync(PAGINATION_OVERRIDE_JS, 'utf8');

        source = source.replace(
          /\nloadData\(\s*false\s*\);\s*\n\ninitSuperLikeRealtime\(\);/,
          '\ninitSuperLikeRealtime();'
        );

        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        return res.send(`${source}\n\n/* server pagination override */\n${override}\n`);
      } catch (error) {
        console.error('[SuperLike分页] 注入前端分页脚本失败：', error);
        return next(error);
      }
    }

    return middleware(req, res, next);
  };
};
