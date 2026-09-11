'use strict';

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

/*
 * post_created_at 已经按北京时间文本保存。
 * 这里不做任何 +8 hours / UTC / timezone 转换，
 * “当天”只比较数据库文本的 YYYY-MM-DD 前缀。
 */
function getTodayKeyNoTimezoneConversion() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/*
 * 与旧前端/Node 逻辑保持一致，把“还需要多少评论才能到 80 分”直接放到 SQL。
 * - NULL: 没有初始经验值
 * - 0: 已经 >= 80
 * - -1: 即使补到 20 评论也到不了 80
 */
const COMMENTS_NEEDED_SQL = `
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

function buildOrderBy(sortKey, direction) {
  const dir = direction === 'asc' ? 'ASC' : 'DESC';

  if (sortKey === 'post_created_at') {
    return `post_created_at ${dir} NULLS LAST, id DESC`;
  }

  if (sortKey === 'comments_count') {
    return `comments_count ${dir} NULLS LAST, post_created_at DESC NULLS LAST, id DESC`;
  }

  if (sortKey === 'comments_needed_for_80') {
    return `comments_needed_for_80 ${dir} NULLS LAST, post_created_at DESC NULLS LAST, id DESC`;
  }

  return `experience_7d ${dir} NULLS LAST, post_created_at DESC NULLS LAST, id DESC`;
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

    const todayKey = getTodayKeyNoTimezoneConversion();
    const where = [
      'sp.current_has_superlike = 0',
      'sp.comments_count < 22'
    ];
    const params = [];

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
        CAST(sp.uid AS TEXT) LIKE ?
        OR COALESCE(sp.username, '') LIKE ?
        OR COALESCE(sp.post_text, '') LIKE ?
        OR COALESCE(sp.icon_summary, '') LIKE ?
      )`);
      const p = `%${keyword}%`;
      params.push(p, p, p, p);
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
              LOWER(COALESCE(sp.username, '')) LIKE '%' || LOWER(bk.keyword) || '%'
              OR LOWER(COALESCE(sp.post_text, '')) LIKE '%' || LOWER(bk.keyword) || '%'
              OR LOWER(COALESCE(sp.icon_summary, '')) LIKE '%' || LOWER(bk.keyword) || '%'
            )
        )
      `);
    }

    if (todayOnly) {
      where.push(`SUBSTR(TRIM(COALESCE(sp.post_created_at, '')), 1, 10) = ?`);
      params.push(todayKey);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;

    /*
     * 统计单独聚合，不再把所有候选帖子拉回 Node。
     */
    const statsRow = db.prepare(`
      SELECT
        COUNT(*) AS total,
        COUNT(DISTINCT NULLIF(TRIM(CAST(sp.uid AS TEXT)), '')) AS user_count,
        SUM(CASE WHEN sp.experience_7d IS NOT NULL THEN 1 ELSE 0 END) AS experience_known
      FROM superlike_posts sp
      ${whereSql}
    `).get(...params) || {};

    const total = Number(statsRow.total || 0);
    const userCount = Number(statsRow.user_count || 0);
    const experienceKnown = Number(statsRow.experience_known || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * pageSize;
    const orderBy = buildOrderBy(sortKey, sortDirection);

    /*
     * 真正的 SQL 分页：PostgreSQL 只返回当前页，不再先 all() 全量读取。
     */
    const data = db.prepare(`
      SELECT *
      FROM (
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
          END AS black_fan_flg,
          ${COMMENTS_NEEDED_SQL} AS comments_needed_for_80
        FROM superlike_posts sp
        LEFT JOIN monitors m ON m.id = sp.monitor_id
        ${whereSql}
      ) paged
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
        user_count: userCount,
        today_became_superlike: getTodaySuperLikePoolExitCount(),
        experience_known: experienceKnown
      },
      filters: {
        hideBlack,
        todayOnly,
        todayKey,
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

const originalGet = express.application.get;
express.application.get = function patchedGet(routePath, ...handlers) {
  if (routePath === '/api/superlike-posts') {
    return originalGet.call(this, routePath, superLikePostsHandler);
  }
  return originalGet.call(this, routePath, ...handlers);
};

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
