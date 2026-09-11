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

const MONTHS = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04',
  May: '05', Jun: '06', Jul: '07', Aug: '08',
  Sep: '09', Oct: '10', Nov: '11', Dec: '12'
};

/*
 * post_created_at 已经按北京时间保存。
 * 这里绝不做 +8 hours、UTC 转换或 SQL date/datetime 解析。
 * 只从“已经保存的字符串”中读取年月日/时分秒。
 */
function parseStoredBeijingPostTime(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  let m = text.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/
  );

  if (m) {
    const [, year, month, day, hour, minute, second] = m;
    return {
      dateKey: `${year}-${month}-${day}`,
      sortKey: `${year}${month}${day}${hour}${minute}${second}`
    };
  }

  m = text.match(
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+[+-]\d{4}\s+(\d{4})$/
  );

  if (m) {
    const [, monthName, rawDay, hour, minute, second, year] = m;
    const month = MONTHS[monthName];
    const day = String(Number(rawDay)).padStart(2, '0');
    return {
      dateKey: `${year}-${month}-${day}`,
      sortKey: `${year}${month}${day}${hour}${minute}${second}`
    };
  }

  return null;
}

function getBeijingTodayKey() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function commentsNeededFor80(row) {
  const exp = Number(row.initial_experience_7d);
  const comments = Number(row.initial_comments_count || 0);

  if (row.initial_experience_7d === null || row.initial_experience_7d === undefined) {
    return null;
  }
  if (exp >= 80) return 0;

  if (comments < 5) {
    if (exp + 1 >= 80) return 5 - comments;
    if (exp + 3 >= 80) return 10 - comments;
    if (exp + 6 >= 80) return 15 - comments;
    if (exp + 10 >= 80) return 20 - comments;
    return -1;
  }
  if (comments < 10) {
    if (exp + 2 >= 80) return 10 - comments;
    if (exp + 5 >= 80) return 15 - comments;
    if (exp + 9 >= 80) return 20 - comments;
    return -1;
  }
  if (comments < 15) {
    if (exp + 3 >= 80) return 15 - comments;
    if (exp + 7 >= 80) return 20 - comments;
    return -1;
  }
  if (comments < 20) {
    if (exp + 4 >= 80) return 20 - comments;
    return -1;
  }
  return -1;
}

function compareNullableNumber(a, b, direction) {
  const aMissing = a === null || a === undefined || a === '';
  const bMissing = b === null || b === undefined || b === '';
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;

  const result = Number(a) - Number(b);
  return direction === 'asc' ? result : -result;
}

function sortRows(rows, sortKey, direction) {
  rows.sort((a, b) => {
    let result = 0;

    if (sortKey === 'post_created_at') {
      const aKey = parseStoredBeijingPostTime(a.post_created_at)?.sortKey || '';
      const bKey = parseStoredBeijingPostTime(b.post_created_at)?.sortKey || '';
      if (!aKey && !bKey) result = 0;
      else if (!aKey) result = 1;
      else if (!bKey) result = -1;
      else result = aKey.localeCompare(bKey);
      if (direction === 'desc') result = -result;
    } else if (sortKey === 'comments_count') {
      result = compareNullableNumber(a.comments_count, b.comments_count, direction);
    } else if (sortKey === 'comments_needed_for_80') {
      result = compareNullableNumber(
        a.comments_needed_for_80,
        b.comments_needed_for_80,
        direction
      );
    } else {
      result = compareNullableNumber(a.experience_7d, b.experience_7d, direction);
    }

    if (result !== 0) return result;

    const aPost = parseStoredBeijingPostTime(a.post_created_at)?.sortKey || '';
    const bPost = parseStoredBeijingPostTime(b.post_created_at)?.sortKey || '';
    const postResult = bPost.localeCompare(aPost);
    if (postResult !== 0) return postResult;

    return Number(b.id || 0) - Number(a.id || 0);
  });
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

    const whereSql = `WHERE ${where.join(' AND ')}`;

    let rows = db.prepare(`
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
        END AS black_fan_flg
      FROM superlike_posts sp
      LEFT JOIN monitors m ON m.id = sp.monitor_id
      ${whereSql}
    `).all(...params);

    rows = rows.map(row => ({
      ...row,
      comments_needed_for_80: commentsNeededFor80(row)
    }));

    if (todayOnly) {
      const todayKey = getBeijingTodayKey();
      rows = rows.filter(row =>
        parseStoredBeijingPostTime(row.post_created_at)?.dateKey === todayKey
      );
    }

    sortRows(rows, sortKey, sortDirection);

    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * pageSize;
    const data = rows.slice(offset, offset + pageSize);

    const userCount = new Set(
      rows.map(row => String(row.uid || '')).filter(Boolean)
    ).size;
    const experienceKnown = rows.filter(
      row => row.experience_7d !== null && row.experience_7d !== undefined
    ).length;

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
