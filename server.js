const express = require('express');
const path = require('path');

const {
  db,
  initDatabase,
  getMonitors,
  getMonitor,
  createMonitor,
  updateMonitor,
  deleteMonitor,
  getMonitorResult,
  getDailyStats,
  getComments,
  getApiResponseById,
  saveSuperLikeUser,
  setSuperLikePostMoved,
  setSuperLikePostsMoved,
  deletePostsByUidSet,
  getTodaySuperLikePoolExitCount
} = require('./src/db');

const { syncMonitorsFromConfig } = require('./src/config');
const { runMonitor } = require('./src/monitor');
const {
  rebuildComments,
  extractComments,
  isSuccessfulResponse
} = require('./src/rebuild-comments');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me';
const APP_ENV = String(process.env.APP_ENV || process.env.NODE_ENV || 'production')
  .trim()
  .toLowerCase();

app.use(express.json({ limit: '2mb' }));

/*
 * ============================================================
 * Public access control
 *
 * Local access:
 *   - allow all existing pages / APIs
 *
 * Cloudflare Tunnel access:
 *   - only expose the SuperLike page
 *   - only expose the exact static assets used by SuperLike
 *   - only expose /api/superlike-posts
 *
 * Other public routes return 404.
 * ============================================================
 */
app.use((req, res, next) => {
  const isCloudflareRequest =
    Boolean(
      req.headers['cf-ray']
      ||
      req.headers['cf-connecting-ip']
    );

  /*
   * localhost / normal local access:
   * keep the original behavior unchanged.
   */
  if (!isCloudflareRequest) {
    return next();
  }

  /*
   * Exact public allowlist.
   *
   * Do not allow every .js/.css file, otherwise files such as
   * admin.js could still be fetched directly from /public.
   */
  const allowedPaths = new Set([
    '/superlike',
    '/superlike.html',
    '/superlike.js',
    '/style.css',
    '/api/superlike-posts',
    '/api/superlike-mark-user',
    '/api/superlike-post-moved',
    '/api/superlike-posts-moved',
    '/api/black-fan-user',
    '/api/environment',
    '/favicon.ico'
  ]);

  if (allowedPaths.has(req.path)) {
    return next();
  }

  /*
   * Hide all other pages / APIs from public access.
   * Return 404 instead of 403 so the route is not advertised.
   */
  return res
    .status(404)
    .type('text/plain')
    .send('Not Found');
});

app.use(express.static(path.join(__dirname, 'public')));

function checkAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({
      success: false,
      message: '未授权'
    });
  }
  next();
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value || '');
  } catch {
    return fallback;
  }
}

function hasErrorMessage(row) {
  return (
    row?.error_message !== null &&
    row?.error_message !== undefined &&
    String(row.error_message).trim() !== ''
  );
}

/* 页面 */
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.get('/admin', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.html'))
);

app.get('/api-responses', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'api-responses.html'))
);

app.get('/superlike', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'superlike.html'))
);

/* 普通 API */
app.get('/api/monitors', (req, res) => {
  try {
    const data = getMonitors(true)
      .filter(m => (m.monitor_type || 'comments') === 'comments')
      .map(monitor => ({
        id: monitor.id,
        name: monitor.name,
        emojis: safeJson(monitor.emojis, []),
        texts: safeJson(monitor.texts, []),
        enabled: !!monitor.enabled,
        last_run_at: monitor.last_run_at,
        last_status: monitor.last_status
      }));

    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/monitors/:id/result', (req, res) => {
  try {
    const result = getMonitorResult(Number(req.params.id));
    if (result) {
      result.emoji_stats = safeJson(result.emoji_stats, {});
      result.text_stats = safeJson(result.text_stats, {});
    }
    res.json({ success: true, data: result || null });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/monitors/:id/history', (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 365);
    const data = getDailyStats(Number(req.params.id), limit)
      .map(row => ({
        ...row,
        emoji_stats: safeJson(row.emoji_stats, {}),
        text_stats: safeJson(row.text_stats, {})
      }));
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/monitors/:id/comments', (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    res.json({
      success: true,
      data: getComments(Number(req.params.id), limit)
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/environment', (req, res) => {
  res.json({
    success: true,
    environment: APP_ENV,
    isTest: APP_ENV === 'test',
    port: Number(PORT)
  });
});


/* SuperLike 候选页面 API */
app.get('/api/superlike-posts', (req, res) => {
  try {
    const keyword = String(req.query.keyword || '').trim();
    const monitorId = req.query.monitorId
      ? Number(req.query.monitorId)
      : null;

    const movedFilter =
      ['all', 'moved', 'unmoved']
        .includes(
          String(
            req.query.moved
            || 'unmoved'
          )
        )
        ? String(
            req.query.moved
            || 'unmoved'
          )
        : 'unmoved';

    /*
     * 默认只显示今天入库的数据。
     * 按 first_seen_at 判断帖子首次入库日期。
     */
    const todayOnly =
      String(
        req.query.todayOnly
        ?? '1'
      ) !== '0';

    /*
     * 默认隐藏命中黑粉关键词的帖子。
     * hideBlack=0 时显示全部。
     */
    const hideBlack =
      String(
        req.query.hideBlack
        ?? '1'
      ) !== '0';

    const where = [
      'sp.current_has_superlike = 0',
      'sp.comments_count < 22'
    ];
    const params = [];

    if (todayOnly) {
      where.push(
        "date(datetime(sp.first_seen_at, '+8 hours')) = date('now', '+8 hours')"
      );
    }

    if (movedFilter === 'moved') {
      where.push(
        'COALESCE(sp.moved_flag, 0) = 1'
      );
    } else if (
      movedFilter === 'unmoved'
    ) {
      where.push(
        'COALESCE(sp.moved_flag, 0) = 0'
      );
    }

    if (monitorId) {
      where.push('sp.monitor_id = ?');
      params.push(monitorId);
    }

    if (keyword) {
      where.push(`
        (
          sp.uid LIKE ?
          OR sp.username LIKE ?
          OR sp.post_text LIKE ?
          OR sp.icon_summary LIKE ?
        )
      `);
      const p = `%${keyword}%`;
      params.push(p, p, p, p);
    }

    if (hideBlack) {
      where.push(`
        /*
         * “屏蔽🐷屎”开启时同时应用两层过滤：
         * 1. UID 已进入 black_fan_users 的用户直接隐藏；
         * 2. 用户名/正文/Icon 命中启用黑粉关键词的帖子隐藏。
         */
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
              LOWER(COALESCE(sp.username, ''))
                LIKE '%' || LOWER(bk.keyword) || '%'
              OR LOWER(COALESCE(sp.post_text, ''))
                LIKE '%' || LOWER(bk.keyword) || '%'
              OR LOWER(COALESCE(sp.icon_summary, ''))
                LIKE '%' || LOWER(bk.keyword) || '%'
            )
        )
      `);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;

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
        sp.current_has_superlike,
        sp.moved_flag,
        sp.icon_summary,
        sp.experience_7d,
        sp.post_created_at,
        sp.inserted_at,
        sp.first_seen_at,
        sp.last_seen_at,
        sp.profile_status
      FROM superlike_posts sp
      LEFT JOIN monitors m ON m.id=sp.monitor_id
      ${whereSql}
      ORDER BY datetime(sp.post_created_at) DESC, sp.id DESC
      LIMIT 2000
    `).all(...params);

    /*
     * 顶部统计与当前页面过滤条件保持一致。
     * 候选帖子 = 当前筛选后实际列表对应的记录数。
     */
    const stats = db.prepare(`
      SELECT
        COUNT(*) AS total,
        COUNT(DISTINCT sp.uid) AS user_count,
        SUM(
          CASE
            WHEN sp.experience_7d IS NOT NULL
            THEN 1
            ELSE 0
          END
        ) AS experience_known
      FROM superlike_posts sp
      ${whereSql}
    `).get(...params);

    const monitors = db.prepare(`
      SELECT id,name
      FROM monitors
      WHERE enabled=1 AND monitor_type='superlike'
      ORDER BY id
    `).all();

    const blackKeywords =
      db.prepare(`
        SELECT keyword
        FROM superlike_black_keywords
        WHERE enabled = 1
        ORDER BY id
      `).all()
      .map(
        row =>
          String(row.keyword || '')
      )
      .filter(Boolean);

    res.json({
      success: true,
      stats: {
        total: Number(stats?.total || 0),
        user_count: Number(stats?.user_count || 0),
        today_became_superlike:
          getTodaySuperLikePoolExitCount(),
        experience_known: Number(stats?.experience_known || 0)
      },
      filters: {
        hideBlack,
        todayOnly,
        moved: movedFilter,
        blackKeywords
      },
      monitors,
      data
    });
  } catch (error) {
    console.error('读取SuperLike候选失败：', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/*
 * 手工确认某个候选用户已经是 SuperLike：
 * - 写入 superlike_users
 * - 删除该 UID 在 superlike_posts 的全部候选
 *
 * 这个接口只需要 UID / monitor_id，不接受任意 SQL 或路径。
 */
app.post('/api/superlike-mark-user', (req, res) => {
  try {
    const monitorId =
      Number(req.body?.monitorId);

    const uid =
      String(
        req.body?.uid
        || ''
      ).trim();

    if (
      !Number.isFinite(monitorId)
      || monitorId <= 0
      || !/^\d+$/.test(uid)
    ) {
      return res.status(400).json({
        success: false,
        message: 'monitorId 或 UID 无效'
      });
    }

    const inserted =
      saveSuperLikeUser(
        monitorId,
        uid
      );

    const deleted =
      deletePostsByUidSet(
        new Set([uid])
      );

    console.log(
      `[SuperLike][人工确认] UID=${uid} 已标记SuperLike | ` +
      `${inserted ? '新增用户' : '用户已存在'} | 删除候选=${deleted}`
    );

    res.json({
      success: true,
      uid,
      inserted,
      deleted
    });

  } catch (error) {
    console.error(
      '[SuperLike][人工确认] 失败：',
      error
    );

    res.status(500).json({
      success: false,
      message:
        error.message
    });
  }
});


/*
 * 人工标记黑粉用户。
 * UID 唯一；重复点击时更新用户名和主页链接，不重复插入。
 */
app.post('/api/black-fan-user', (req, res) => {
  try {
    const uid =
      String(
        req.body?.uid
        || ''
      ).trim();

    const username =
      String(
        req.body?.username
        || ''
      ).trim();

    if (!/^\d+$/.test(uid)) {
      return res.status(400).json({
        success: false,
        message: 'UID 无效'
      });
    }

    const profileLink =
      'https://m.weibo.cn/u/'
      + encodeURIComponent(uid);

    const result =
      db.prepare(`
        INSERT INTO black_fan_users(
          uid,
          username,
          profile_link
        )
        VALUES(?,?,?)
        ON CONFLICT(uid) DO UPDATE SET
          username = excluded.username,
          profile_link = excluded.profile_link
      `).run(
        uid,
        username || null,
        profileLink
      );

    console.log(
      `[BlackFan][人工标记] UID=${uid} | 用户=${username || '-'}`
    );

    res.json({
      success: true,
      uid,
      inserted:
        Number(result.changes || 0) > 0
    });
  } catch (error) {
    console.error(
      '[BlackFan][人工标记] 失败：',
      error
    );

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});


/*
 * 标记/取消“已搬运”。
 * moved=true  -> 已搬运
 * moved=false -> 未搬运
 */
app.post('/api/superlike-post-moved', (req, res) => {
  try {
    const id = Number(req.body?.id);
    const moved = req.body?.moved === true;

    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: '帖子ID无效'
      });
    }

    const changed = setSuperLikePostMoved(id, moved);

    if (!changed) {
      return res.status(404).json({
        success: false,
        message: '帖子不存在或已被删除'
      });
    }

    res.json({
      success: true,
      id,
      moved_flag: moved ? 1 : 0
    });
  } catch (error) {
    console.error('[SuperLike][搬运状态] 更新失败：', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});


/*
 * 批量标记搬运状态。
 * 主要用于“下载当前搜索结果 CSV”后，把本次导出的帖子一起标为已搬运。
 */
app.post('/api/superlike-posts-moved', (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids
      : [];

    const normalizedIds = Array.from(
      new Set(
        ids
          .map(id => Number(id))
          .filter(id => Number.isFinite(id) && id > 0)
      )
    );

    if (normalizedIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: '没有有效的帖子ID'
      });
    }

    if (normalizedIds.length > 2000) {
      return res.status(400).json({
        success: false,
        message: '一次最多处理2000条帖子'
      });
    }

    const changed =
      setSuperLikePostsMoved(
        normalizedIds,
        true
      );

    res.json({
      success: true,
      changed,
      moved_flag: 1
    });
  } catch (error) {
    console.error('[SuperLike][批量搬运状态] 更新失败：', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});


/* 评论看板 */
app.get('/api/comments-dashboard', (req, res) => {
  try {
    const requestedPage = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(
      200,
      Math.max(20, Number(req.query.pageSize) || 100)
    );
    const attribute = String(req.query.attribute || '').trim();
    const keyword = String(req.query.keyword || '').trim();

    const lemonCondition = `(
      c.content LIKE '%🍋%' OR
      c.content LIKE '%💛%' OR
      c.content LIKE '%水水%' OR
      c.content LIKE '%田柠%' OR
      c.content LIKE '%柠檬%'
    )`;

    const cornCondition = `(
      c.content LIKE '%🌽%' OR
      c.content LIKE '%🌙%' OR
      c.content LIKE '%cpf%' OR
      c.content LIKE '%甜玉米%' OR
      c.content LIKE '%米米%' OR
      c.content LIKE '%雷朋%'
    )`;

    const stats = db.prepare(`
      SELECT
        SUM(CASE WHEN ${lemonCondition} THEN 1 ELSE 0 END) AS lemon_count,
        SUM(CASE WHEN ${cornCondition} THEN 1 ELSE 0 END) AS corn_count,
        SUM(CASE WHEN NOT ${lemonCondition} AND NOT ${cornCondition}
            THEN 1 ELSE 0 END) AS none_count
      FROM comments c
    `).get();

    const where = [];
    const params = [];

    if (attribute === 'lemon') where.push(lemonCondition);
    if (attribute === 'corn') where.push(cornCondition);
    if (attribute === 'none') {
      where.push(`NOT ${lemonCondition} AND NOT ${cornCondition}`);
    }

    if (keyword) {
      where.push(`(
        c.content LIKE ?
        OR c.buyer_nickname LIKE ?
        OR c.customerid LIKE ?
        OR c.comment_id LIKE ?
      )`);
      const p = `%${keyword}%`;
      params.push(p, p, p, p);
    }

    const whereSql = where.length
      ? `WHERE ${where.join(' AND ')}`
      : '';

    const total = Number(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM comments c
        ${whereSql}
      `).get(...params)?.count || 0
    );

    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * pageSize;

    const rows = db.prepare(`
      SELECT
        c.*,
        CASE WHEN ${lemonCondition} THEN 1 ELSE 0 END AS is_lemon,
        CASE WHEN ${cornCondition} THEN 1 ELSE 0 END AS is_corn
      FROM comments c
      ${whereSql}
      ORDER BY
        CASE
          WHEN c.comment_time GLOB '[0-9]*'
          THEN CAST(c.comment_time AS INTEGER)
          ELSE 0
        END DESC,
        c.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    const data = rows.map(row => {
      const attributes = [];
      if (row.is_lemon) attributes.push('柠檬水');
      if (row.is_corn) attributes.push('甜玉米');
      if (!attributes.length) attributes.push('无属性');

      return {
        id: row.id,
        monitor_id: row.monitor_id,
        comment_id: row.comment_id,
        buyer_nickname: row.buyer_nickname || '',
        customerid: row.customerid || '',
        sku_name: row.sku_name || '',
        content: row.content || '',
        comment_time: row.comment_time,
        first_seen_at: row.first_seen_at,
        attributes
      };
    });

    res.json({
      success: true,
      stats: {
        lemon: Number(stats?.lemon_count || 0),
        corn: Number(stats?.corn_count || 0),
        none: Number(stats?.none_count || 0)
      },
      data,
      pagination: { page, pageSize, total, totalPages }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/* Admin Monitor API */
app.get('/api/admin/monitors', checkAdmin, (req, res) => {
  try {
    const data = getMonitors(false).map(monitor => ({
      ...monitor,
      emojis: safeJson(monitor.emojis, []),
      texts: safeJson(monitor.texts, []),
      enabled: !!monitor.enabled
    }));
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/admin/monitors', checkAdmin, (req, res) => {
  try {
    const {
      name, url, emojis = [], texts = [], enabled = true,
      monitor_type = 'comments'
    } = req.body;

    if (!name || !url) {
      return res.status(400).json({
        success: false,
        message: '名称和 URL 不能为空'
      });
    }

    const id = createMonitor({
      name, url, emojis, texts, enabled, monitor_type
    });

    /* SuperLike Monitor 不走普通商品评论 runMonitor */
    if (monitor_type !== 'superlike') {
      setImmediate(() => {
        runMonitor(id).catch(console.error);
      });
    }

    res.json({ success: true, id });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/admin/monitors/:id', checkAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const monitor = getMonitor(id);

    if (!monitor) {
      return res.status(404).json({
        success: false,
        message: '监控项目不存在'
      });
    }

    const {
      name, url, emojis = [], texts = [], enabled = true,
      monitor_type = monitor.monitor_type || 'comments'
    } = req.body;

    updateMonitor(id, {
      name, url, emojis, texts, enabled, monitor_type
    });

    if (monitor_type !== 'superlike') {
      setImmediate(() => {
        runMonitor(id).catch(console.error);
      });
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/admin/monitors/:id', checkAdmin, (req, res) => {
  try {
    deleteMonitor(Number(req.params.id));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/admin/monitors/:id/run', checkAdmin, (req, res) => {
  const id = Number(req.params.id);
  const monitor = getMonitor(id);

  if (!monitor) {
    return res.status(404).json({
      success: false,
      message: '监控项目不存在'
    });
  }

  if ((monitor.monitor_type || 'comments') === 'superlike') {
    return res.status(400).json({
      success: false,
      message: 'SuperLike Monitor 请使用 npm run scan-superlike'
    });
  }

  setImmediate(() => {
    runMonitor(id).catch(console.error);
  });

  res.json({ success: true, message: '已开始抓取' });
});

/* API Responses 管理 */
app.get('/api/admin/api-responses', checkAdmin, (req, res) => {
  try {
    const monitorId = req.query.monitorId
      ? Number(req.query.monitorId)
      : null;
    const generationStatus =
      String(req.query.generationStatus || '').trim();
    const keyword = String(req.query.keyword || '').trim();
    const requestedPage = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(
      200,
      Math.max(10, Number(req.query.pageSize) || 50)
    );

    const where = [];
    const params = [];

    if (monitorId) {
      where.push('ar.monitor_id=?');
      params.push(monitorId);
    }

    if (keyword) {
      where.push(`COALESCE(ar.response_json,'') LIKE ?`);
      params.push(`%${keyword}%`);
    }

    const whereSql = where.length
      ? `WHERE ${where.join(' AND ')}`
      : '';

    const rows = db.prepare(`
      SELECT ar.*,m.name AS monitor_name
      FROM api_responses ar
      LEFT JOIN monitors m ON m.id=ar.monitor_id
      ${whereSql}
      ORDER BY ar.id DESC
      LIMIT 5000
    `).all(...params);

    let data = rows.map(row => {
      let comments = [];
      let generatedCount = 0;
      let currentGenerationStatus = '请求失败';

      if (hasErrorMessage(row)) {
        currentGenerationStatus = '请求失败';
      } else if (row.response_json) {
        try {
          const raw = JSON.parse(row.response_json);

          if (!isSuccessfulResponse(raw)) {
            currentGenerationStatus = '请求失败';
          } else {
            comments = extractComments(raw);

            if (!comments.length) {
              currentGenerationStatus = '无评论数据';
            } else {
              const ids = comments
                .map(c => String(
                  c.comment_id ?? c.commentId ?? c.id ?? c.cid ?? ''
                ))
                .filter(Boolean);

              if (ids.length) {
                const placeholders = ids.map(() => '?').join(',');
                generatedCount = Number(
                  db.prepare(`
                    SELECT COUNT(DISTINCT comment_id) AS count
                    FROM comments
                    WHERE comment_id IN (${placeholders})
                  `).get(...ids)?.count || 0
                );
              }

              if (generatedCount === 0) {
                currentGenerationStatus = '未生成';
              } else if (generatedCount >= comments.length) {
                currentGenerationStatus = '已全部生成';
              } else {
                currentGenerationStatus = '部分已生成';
              }
            }
          }
        } catch {
          currentGenerationStatus = '请求失败';
        }
      }

      return {
        ...row,
        comment_count: comments.length,
        generated_count: generatedCount,
        generation_status: currentGenerationStatus
      };
    });

    if (generationStatus) {
      data = data.filter(
        row => row.generation_status === generationStatus
      );
    }

    const total = data.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const start = (page - 1) * pageSize;

    res.json({
      success: true,
      data: data.slice(start, start + pageSize),
      pagination: {
        page, pageSize, total, totalPages
      }
    });
  } catch (error) {
    console.error('查询 api_responses 失败：', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.get('/api/admin/api-responses/:id', checkAdmin, (req, res) => {
  try {
    const row = getApiResponseById(Number(req.params.id));
    if (!row) {
      return res.status(404).json({
        success: false,
        message: 'Response 不存在'
      });
    }
    res.json({ success: true, data: row });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post(
  '/api/admin/api-responses/:id/generate',
  checkAdmin,
  (req, res) => {
    try {
      const responseId = Number(req.params.id);
      const row = getApiResponseById(responseId);

      if (!row) {
        return res.status(404).json({
          success: false,
          message: 'Response 不存在'
        });
      }

      if (!row.response_json || !String(row.response_json).trim()) {
        return res.status(400).json({
          success: false,
          message: '这条 Response 没有 JSON 数据'
        });
      }

      if (hasErrorMessage(row)) {
        return res.status(400).json({
          success: false,
          message: '这条 Response 是失败记录，不能生成 comments'
        });
      }

      let raw;
      try {
        raw = JSON.parse(row.response_json);
      } catch {
        return res.status(400).json({
          success: false,
          message: 'response_json 不是有效 JSON'
        });
      }

      if (!isSuccessfulResponse(raw)) {
        return res.status(400).json({
          success: false,
          message: `这条 Response code=${raw?.code}，不是成功 Response`
        });
      }

      const comments = extractComments(raw);
      if (!comments.length) {
        return res.status(400).json({
          success: false,
          message: '没有从 Response 中识别到评论'
        });
      }

      const result = rebuildComments({ responseId });

      res.json({
        success: true,
        message:
          `生成完成：解析 ${result.parsedCommentCount} 条，新增 ${result.insertedCount} 条，已存在跳过 ${result.skippedCount} 条`,
        responseId,
        parsedCommentCount: result.parsedCommentCount,
        insertedCount: result.insertedCount,
        skippedCount: result.skippedCount,
        invalidCommentCount: result.invalidCommentCount,
        insertErrorCount: result.insertErrorCount
      });
    } catch (error) {
      console.error('手动生成 comments 失败：', error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);

/* Server 启动：只开 Web/API，不自动跑任何 Batch */
async function start() {
  initDatabase();
  syncMonitorsFromConfig();

  app.listen(PORT, () => {
    console.log('====================================');
    console.log('Weibo Emoji Monitor');
    console.log(`Environment: ${APP_ENV.toUpperCase()}`);
    console.log(`http://localhost:${PORT}`);
    console.log(`http://localhost:${PORT}/admin`);
    console.log(`http://localhost:${PORT}/api-responses`);
    console.log(`http://localhost:${PORT}/superlike`);
    console.log('====================================');
  });
}

start().catch(error => {
  console.error('Server startup failed:', error);
  process.exit(1);
});
