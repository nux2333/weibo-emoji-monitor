const express = require('express');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const os = require('os');

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
  addSuperLikePoolExitCount,
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

/*
 * SuperLike 多人实时状态同步。
 * 每个打开 /superlike 的浏览器维持一个轻量 SSE 连接；
 * 任一用户标记 moved 后，广播给其他在线页面。
 */
const superLikeEventClients =
  new Set();

function broadcastSuperLikeEvent(
  eventName,
  data = {}
) {
  const safeEventName =
    String(eventName || '')
      .trim()
      .replace(
        /[^a-z0-9_-]/gi,
        ''
      );

  if (!safeEventName) {
    return;
  }

  const payload =
    JSON.stringify({
      type:
        safeEventName,
      ...data,
      ts:
        Date.now()
    });

  for (
    const res
    of superLikeEventClients
  ) {
    try {
      res.write(
        `event: ${safeEventName}\ndata: ${payload}\n\n`
      );
    } catch {
      superLikeEventClients.delete(
        res
      );
    }
  }
}


function broadcastSuperLikeMoved(
  ids,
  moved = true
) {
  const normalizedIds =
    Array.from(
      new Set(
        (ids || [])
          .map(id => Number(id))
          .filter(
            id =>
              Number.isFinite(id)
              &&
              id > 0
          )
      )
    );

  if (
    normalizedIds.length === 0
  ) {
    return;
  }

  broadcastSuperLikeEvent(
    'moved',
    {
      ids:
        normalizedIds,
      moved:
        moved === true
    }
  );
}

/*
 * 默认只监听本机回环地址。
 * Cloudflare Tunnel 应连接 http://127.0.0.1:PORT，
 * 不要把 Node 端口直接暴露到公网。
 */
const HOST = String(process.env.HOST || '127.0.0.1').trim();

const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '').trim();
if (!ADMIN_TOKEN || ADMIN_TOKEN === 'change-me') {
  throw new Error(
    'ADMIN_TOKEN 未配置或仍为 change-me。请先设置一个随机长 Token，再启动服务器。'
  );
}

const APP_ENV = String(process.env.APP_ENV || process.env.NODE_ENV || 'production')
  .trim()
  .toLowerCase();

/*
 * Helmet 安全响应头。
 * 现有页面包含 inline script/style，因此暂时关闭 CSP，避免直接把现有管理页面打坏；
 * 其余常用安全 Header 继续启用。
 */
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity:
      APP_ENV === 'production'
        ? {
            maxAge: 31536000,
            includeSubDomains: true
          }
        : false
  })
);

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

/*
 * 公开访问轻量限流。
 * - 按 Cloudflare 真实客户端 IP（cf-connecting-ip）计数；
 * - 每个 IP 每分钟最多 120 个请求；
 * - 只限制经 Cloudflare 进入的公网流量，本机管理不受影响。
 *
 * 这不是 Cloudflare WAF/Rate Limiting 的替代品，而是源站最后一道保护。
 */
const PUBLIC_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const PUBLIC_RATE_LIMIT_MAX = 120;
const publicRateBuckets = new Map();

function getPublicClientIp(req) {
  return String(
    req.headers['cf-connecting-ip']
    || req.socket?.remoteAddress
    || 'unknown'
  ).trim();
}

function publicRateLimit(req, res, next) {
  const isCloudflareRequest =
    Boolean(
      req.headers['cf-ray']
      || req.headers['cf-connecting-ip']
    );

  if (!isCloudflareRequest) {
    return next();
  }

  const now = Date.now();
  const key = getPublicClientIp(req);
  const current = publicRateBuckets.get(key);

  if (
    !current
    || now - current.startedAt >= PUBLIC_RATE_LIMIT_WINDOW_MS
  ) {
    publicRateBuckets.set(key, {
      startedAt: now,
      count: 1
    });
    res.setHeader('X-RateLimit-Limit', String(PUBLIC_RATE_LIMIT_MAX));
    res.setHeader('X-RateLimit-Remaining', String(PUBLIC_RATE_LIMIT_MAX - 1));
    return next();
  }

  current.count += 1;
  const remaining =
    Math.max(0, PUBLIC_RATE_LIMIT_MAX - current.count);

  res.setHeader('X-RateLimit-Limit', String(PUBLIC_RATE_LIMIT_MAX));
  res.setHeader('X-RateLimit-Remaining', String(remaining));

  if (current.count > PUBLIC_RATE_LIMIT_MAX) {
    const retryAfterSeconds =
      Math.max(
        1,
        Math.ceil(
          (
            PUBLIC_RATE_LIMIT_WINDOW_MS
            - (now - current.startedAt)
          ) / 1000
        )
      );

    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({
      success: false,
      message: '请求过于频繁，请稍后再试'
    });
  }

  return next();
}

setInterval(() => {
  const cutoff = Date.now() - PUBLIC_RATE_LIMIT_WINDOW_MS * 2;
  for (const [key, value] of publicRateBuckets) {
    if (value.startedAt < cutoff) {
      publicRateBuckets.delete(key);
    }
  }
}, PUBLIC_RATE_LIMIT_WINDOW_MS).unref?.();

app.use(publicRateLimit);

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

    /*
     * 远程管理页面本身允许通过 Cloudflare 打开。
     * 真正的管理操作仍全部由 /api/admin/* + ADMIN_TOKEN 鉴权。
     */
    '/admin',
    '/admin.html',
    '/scripts',
    '/scripts.html',
    '/logs-live',
    '/logs-live.html',
    '/monitors-admin',
    '/monitors-admin.html',

    '/api/superlike-posts',
    '/api/superlike-events',
    '/api/superlike-move-intent',
    '/api/superlike-mark-user',
    '/api/superlike-post-moved',
    '/api/superlike-posts-moved',
    '/api/black-fan-user',
    '/api/environment',
    '/favicon.ico'
  ]);

  /*
   * 管理 API 允许经过 Cloudflare 到达 Express，
   * 但后续路由仍必须通过 checkAdmin(ADMIN_TOKEN)。
   * 这里只放行路径，不等于取消鉴权。
   */
  if (
    allowedPaths.has(req.path)
    ||
    req.path.startsWith('/api/admin/')
  ) {
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

app.get('/monitors-admin', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'monitors-admin.html'))
);

app.get('/api-responses', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'api-responses.html'))
);

app.get('/superlike', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'superlike.html'))
);

/*
 * SuperLike moved_flag 实时广播。
 * SSE 比页面轮询轻得多：30~100个在线用户只维持长连接，
 * 状态改变时才发送一小段事件。
 */
app.get(
  '/api/superlike-events',
  (req, res) => {
    res.status(200);
    res.setHeader(
      'Content-Type',
      'text/event-stream; charset=utf-8'
    );
    res.setHeader(
      'Cache-Control',
      'no-cache, no-transform'
    );
    res.setHeader(
      'Connection',
      'keep-alive'
    );
    res.setHeader(
      'X-Accel-Buffering',
      'no'
    );

    res.flushHeaders?.();

    superLikeEventClients.add(
      res
    );

    res.write(
      `event: connected\ndata: {"ok":true}\n\n`
    );

    const heartbeat =
      setInterval(
        () => {
          try {
            res.write(
              ': keepalive\n\n'
            );
          } catch {
            clearInterval(
              heartbeat
            );
          }
        },
        20000
      );

    req.on(
      'close',
      () => {
        clearInterval(
          heartbeat
        );

        superLikeEventClients.delete(
          res
        );
      }
    );
  }
);

/*
 * Copy 抢占广播：
 * 用户一点击 Copy 就先广播 moved=true，
 * 不等待 SQLite 写入完成，尽量缩短多人同时抢到同一帖子的窗口。
 * 真正持久化仍由 /api/superlike-posts-moved 完成。
 */
app.post(
  '/api/superlike-move-intent',
  (req, res) => {
    try {
      const ids =
        Array.isArray(
          req.body?.ids
        )
          ? req.body.ids
          : [];

      const normalizedIds =
        Array.from(
          new Set(
            ids
              .map(
                id =>
                  Number(id)
              )
              .filter(
                id =>
                  Number.isFinite(id)
                  &&
                  id > 0
              )
          )
        );

      if (
        normalizedIds.length
        === 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            '没有有效的帖子ID'
        });
      }

      if (
        normalizedIds.length
        > 200
      ) {
        return res.status(400).json({
          success: false,
          message:
            '一次最多广播200条'
        });
      }

      broadcastSuperLikeMoved(
        normalizedIds,
        true
      );

      return res.json({
        success: true,
        ids:
          normalizedIds
      });

    } catch (error) {
      console.error(
        '[SuperLike][抢占广播] 失败：',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          error.message
      });
    }
  }
);

app.get('/logs-live', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'logs-live.html'))
);

app.get('/scripts', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'scripts.html'))
);

/*
 * 实时日志（仅本机/内网管理员页面）。
 * SSE 每秒检查 logs 下最新 .log；新一轮生成新文件时自动切换。
 */
function findLatestLogFile() {
  const roots = [
    path.join(__dirname, 'logs'),
    path.join(__dirname, 'log')
  ].filter(p => fs.existsSync(p));

  let best = null;

  function walk(dir, depth = 0) {
    if (depth > 5) return;

    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }

      if (!entry.isFile() || !/\.log$/i.test(entry.name)) {
        continue;
      }

      try {
        const stat = fs.statSync(full);
        if (!best || stat.mtimeMs > best.mtimeMs) {
          best = { path: full, mtimeMs: stat.mtimeMs, size: stat.size };
        }
      } catch {
        // 文件可能正在轮转，下一次再读
      }
    }
  }

  for (const root of roots) walk(root);

  return best;
}

function readLogTail(filePath, maxBytes = 128 * 1024) {
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  if (length <= 0) return '';

  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

function getLogRoots() {
  return [
    path.join(__dirname, 'logs'),
    path.join(__dirname, 'log')
  ].filter(p => fs.existsSync(p));
}

function listLogFiles() {
  const files = [];

  function walk(dir, depth = 0) {
    if (depth > 5) return;

    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }

      if (!entry.isFile() || !/\.log$/i.test(entry.name)) {
        continue;
      }

      try {
        const stat = fs.statSync(full);
        files.push({
          fullPath: full,
          file: path.relative(__dirname, full).replace(/\\/g, '/'),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          updatedAt: new Date(stat.mtimeMs).toISOString()
        });
      } catch {
        // ignore transient rotation errors
      }
    }
  }

  for (const root of getLogRoots()) walk(root);

  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 300);
}

function resolveSelectedLogFile(relativeFile) {
  const normalized =
    String(relativeFile || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');

  if (!normalized || !/\.log$/i.test(normalized)) {
    return null;
  }

  const full =
    path.resolve(
      __dirname,
      normalized
    );

  const allowed =
    getLogRoots().some(root => {
      const resolvedRoot = path.resolve(root);
      return (
        full === resolvedRoot
        ||
        full.startsWith(resolvedRoot + path.sep)
      );
    });

  if (!allowed) {
    return null;
  }

  if (
    !fs.existsSync(full)
    ||
    !fs.statSync(full).isFile()
  ) {
    return null;
  }

  return full;
}

app.get('/api/admin/live-log/tree', checkAdmin, (req, res) => {
  try {
    const requested =
      String(req.query.path || '')
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '');

    const roots = getLogRoots();
    let target;

    if (!requested) {
      const data = roots.map(root => ({
        name: path.basename(root),
        path: path.relative(__dirname, root).replace(/\\/g, '/'),
        type: 'directory'
      }));

      return res.json({ success: true, path: '', data });
    }

    target = path.resolve(__dirname, requested);

    const allowed = roots.some(root => {
      const rr = path.resolve(root);
      return target === rr || target.startsWith(rr + path.sep);
    });

    if (!allowed || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      return res.status(400).json({ success: false, message: '目录无效或不存在' });
    }

    const data = fs.readdirSync(target, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || (entry.isFile() && /\.log$/i.test(entry.name)))
      .map(entry => {
        const full = path.join(target, entry.name);
        let updatedAt = null;
        let size = null;
        try {
          const stat = fs.statSync(full);
          updatedAt = new Date(stat.mtimeMs).toISOString();
          if (entry.isFile()) size = stat.size;
        } catch {}

        return {
          name: entry.name,
          path: path.relative(__dirname, full).replace(/\\/g, '/'),
          type: entry.isDirectory() ? 'directory' : 'file',
          updatedAt,
          size
        };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
      });

    res.json({
      success: true,
      path: requested,
      parent: path.dirname(requested).replace(/\\/g, '/') === '.'
        ? ''
        : path.dirname(requested).replace(/\\/g, '/'),
      data
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/admin/live-log/files', checkAdmin, (req, res) => {
  try {
    res.json({
      success: true,
      data: listLogFiles().map(item => ({
        file: item.file,
        size: item.size,
        updatedAt: item.updatedAt
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/admin/live-log/status', checkAdmin, (req, res) => {
  try {
    const latest = findLatestLogFile();
    res.json({
      success: true,
      data: latest
        ? {
            file: path.relative(__dirname, latest.path),
            updatedAt: new Date(latest.mtimeMs).toISOString(),
            size: latest.size
          }
        : null
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/admin/live-log/stream', checkAdmin, (req, res) => {
  const requestedFile =
    String(req.query.file || '').trim();

  const selectedFullPath =
    requestedFile
      ? resolveSelectedLogFile(requestedFile)
      : null;

  if (requestedFile && !selectedFullPath) {
    return res
      .status(400)
      .json({
        success: false,
        message: '日志文件无效或不存在'
      });
  }

  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  let currentFile = '';
  let offset = 0;
  let closed = false;

  const send = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const tick = () => {
    if (closed) return;

    try {
      const target =
        selectedFullPath
          ? {
              path: selectedFullPath,
              size: fs.statSync(selectedFullPath).size,
              mtimeMs: fs.statSync(selectedFullPath).mtimeMs
            }
          : findLatestLogFile();

      if (!target) {
        send('status', { state: 'waiting', message: '等待日志文件...' });
        return;
      }

      if (target.path !== currentFile) {
        currentFile = target.path;
        const tail = readLogTail(currentFile);
        offset = fs.statSync(currentFile).size;

        send('switch', {
          file: path.relative(__dirname, currentFile).replace(/\\/g, '/'),
          text: tail,
          fixed: Boolean(selectedFullPath)
        });
        return;
      }

      const stat = fs.statSync(currentFile);

      if (stat.size < offset) {
        offset = 0;
      }

      if (stat.size > offset) {
        const length = stat.size - offset;
        const fd = fs.openSync(currentFile, 'r');

        try {
          const buffer = Buffer.alloc(length);
          fs.readSync(fd, buffer, 0, length, offset);
          offset = stat.size;
          send('append', { text: buffer.toString('utf8') });
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch (error) {
      send('error', { message: error.message });
    }
  };

  tick();
  const timer = setInterval(tick, 1000);
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15000);

  req.on('close', () => {
    closed = true;
    clearInterval(timer);
    clearInterval(heartbeat);
  });
});

/*
 * ============================================================
 * PM2 脚本管理
 *
 * 只允许固定白名单脚本，绝不接受前端传入任意命令/路径。
 * ============================================================
 */
function findPm2CliScript() {
  if (process.platform !== 'win32') {
    return null;
  }

  const candidates = [
    process.env.APPDATA
      ? path.join(process.env.APPDATA, 'npm', 'node_modules', 'pm2', 'bin', 'pm2')
      : '',
    process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming', 'npm', 'node_modules', 'pm2', 'bin', 'pm2')
      : '',
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'pm2', 'bin', 'pm2')
  ].filter(Boolean);

  return candidates.find(file => fs.existsSync(file)) || null;
}

const PM2_CLI_SCRIPT = findPm2CliScript();

const SCRIPT_DEFINITIONS = [
  {
    key: 'fresh-latest',
    name: '最新发帖扫描',
    pm2Name: 'scan-fresh-latest',
    description: 'Fresh：最新发帖总流',
    group: 'scan'
  },
  {
    key: 'fresh-superlike',
    name: '超like分区扫描',
    pm2Name: 'scan-fresh-superlike',
    description: 'Fresh：超like分区',
    group: 'scan'
  },
  {
    key: 'fresh-yishanshui',
    name: '一善水区扫描',
    pm2Name: 'scan-fresh-yishanshui',
    description: 'Fresh：一善水区',
    group: 'scan'
  },
  {
    key: 'fresh-qa',
    name: '答疑专区扫描',
    pm2Name: 'scan-fresh-qa',
    description: 'Fresh：答疑专区',
    group: 'scan'
  },
  {
    key: 'history',
    name: 'History补充扫描',
    pm2Name: 'scan-history',
    description: '仅补最近48小时历史Resume',
    group: 'scan'
  },
  {
    key: 'mode1',
    name: 'Mode1',
    pm2Name: 'superlike-mode1',
    description: '手动复检 Mode1',
    group: 'recheck'
  },
  {
    key: 'mode2',
    name: 'Mode2 评论双队列（HOT 18-20每30秒独立；NORMAL 0-17按到期轮询；>=21删除）',
    pm2Name: 'superlike-mode2',
    description: '手动复检 Mode2',
    group: 'recheck'
  },
  {
    key: 'mode3',
    name: 'Mode3全量UID分批轮询（jyz最高优先；只查询当天的>=70分的用户 变超like了立马删除）',
    pm2Name: 'superlike-mode3',
    description: '手动复检 Mode3',
    group: 'recheck'
  },
  {
    key: 'mode4',
    name: 'Mode4 超LIKE名单',
    pm2Name: 'superlike-mode4',
    description: '24小时扫描超LIKE用户列表',
    group: 'service'
  },
  {
    key: 'jyz',
    name: '补经验值',
    pm2Name: 'superlike-jyz',
    description: '24小时补experience_7d；>=80自动清理候选',
    group: 'service'
  },
  {
    key: 'stale-refresh',
    name: '旧帖刷新',
    pm2Name: 'refresh-stale-superlike-posts',
    description: '刷新前天及更早的旧帖；检查超LIKE、经验值并替换最新帖',
    group: 'service'
  },
  {
    key: 'proxy-pool',
    name: '代理池维护',
    pm2Name: 'weibo-proxy-pool',
    description: '每15分钟维护健康代理池',
    group: 'service'
  }
];

const PM2_BATCH_CONFIG =
  path.join(
    __dirname,
    'ecosystem.batches.config.js'
  );

function runPm2(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      cwd: __dirname,
      windowsHide: true,
      env: {
        ...process.env,
        ...extraEnv
      },
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8'
    };

    /*
     * Windows 下不要经过 pm2.cmd / cmd.exe。
     * 直接用当前 node.exe 执行 PM2 的 JS CLI，
     * 这样网页点击启动/停止不会弹黑色命令行窗口。
     */
    const command =
      process.platform === 'win32'
        ? process.execPath
        : 'pm2';

    const commandArgs =
      process.platform === 'win32'
        ? (
            PM2_CLI_SCRIPT
              ? [PM2_CLI_SCRIPT, ...args]
              : []
          )
        : args;

    if (
      process.platform === 'win32'
      &&
      !PM2_CLI_SCRIPT
    ) {
      reject(
        new Error(
          '找不到 PM2 CLI，请确认已执行 npm.cmd install pm2@latest -g'
        )
      );
      return;
    }

    execFile(
      command,
      commandArgs,
      options,
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }

        resolve({
          stdout: String(stdout || ''),
          stderr: String(stderr || '')
        });
      }
    );
  });
}

async function getPm2Processes() {
  const result = await runPm2(['jlist']);

  try {
    return JSON.parse(result.stdout || '[]');
  } catch (error) {
    throw new Error(
      'PM2 状态解析失败：'
      + error.message
    );
  }
}

function getScriptDefinition(key) {
  return SCRIPT_DEFINITIONS.find(
    item => item.key === String(key || '')
  ) || null;
}

function normalizePm2Status(proc) {
  const env = proc?.pm2_env || {};

  return {
    pm2Name: proc?.name || '',
    pid: Number(proc?.pid || 0) || null,
    status: String(env.status || 'unknown'),
    restartCount: Number(env.restart_time || 0),
    startedAt:
      Number(env.pm_uptime || 0) > 0
        ? new Date(Number(env.pm_uptime)).toISOString()
        : null,
    uptimeMs:
      Number(env.pm_uptime || 0) > 0
        ? Math.max(0, Date.now() - Number(env.pm_uptime))
        : 0,
    memory:
      Number(proc?.monit?.memory || 0),
    cpu:
      Number(proc?.monit?.cpu || 0)
  };
}

app.get('/api/admin/scripts', checkAdmin, async (req, res) => {
  try {
    const processes =
      await getPm2Processes();

    const byName =
      new Map(
        processes.map(proc => [
          String(proc?.name || ''),
          proc
        ])
      );

    const data =
      SCRIPT_DEFINITIONS.map(def => {
        const proc =
          byName.get(def.pm2Name);

        return {
          key: def.key,
          name: def.name,
          pm2Name: def.pm2Name,
          description: def.description || '',
          group: def.group || '',
          ...(proc
            ? normalizePm2Status(proc)
            : {
                pid: null,
                status: 'not_created',
                restartCount: 0,
                startedAt: null,
                uptimeMs: 0,
                memory: 0,
                cpu: 0
              })
        };
      });

    const serverProc =
      byName.get('weibo-server');

    res.json({
      success: true,
      server: serverProc
        ? normalizePm2Status(serverProc)
        : null,
      data
    });

  } catch (error) {
    console.error('[PM2] 读取状态失败：', error);
    res.status(500).json({
      success: false,
      message:
        error.message
        + (error.stderr
          ? ' | ' + String(error.stderr).trim()
          : '')
    });
  }
});

app.post('/api/admin/scripts/:key/:action', checkAdmin, async (req, res) => {
  try {
    const def =
      getScriptDefinition(
        req.params.key
      );

    if (!def) {
      return res.status(404).json({
        success: false,
        message: '未知脚本'
      });
    }

    const action =
      String(req.params.action || '');

    if (
      ![
        'start',
        'stop',
        'restart',
        'delete'
      ].includes(action)
    ) {
      return res.status(400).json({
        success: false,
        message: '不支持的操作'
      });
    }

    const processes =
      await getPm2Processes();

    const exists =
      processes.some(
        proc =>
          String(proc?.name || '')
          === def.pm2Name
      );

    if (action === 'start') {
      if (exists) {
        await runPm2(
          [
            'start',
            def.pm2Name,
            '--update-env'
          ],
          {}
        );
      } else {
        await runPm2(
          [
            'start',
            PM2_BATCH_CONFIG,
            '--only',
            def.pm2Name
          ],
          {}
        );
      }

    } else if (action === 'restart') {
      if (exists) {
        await runPm2(
          [
            'restart',
            def.pm2Name,
            '--update-env'
          ],
          {}
        );
      } else {
        await runPm2(
          [
            'start',
            PM2_BATCH_CONFIG,
            '--only',
            def.pm2Name
          ],
          {}
        );
      }

    } else if (action === 'stop') {
      if (exists) {
        await runPm2([
          'stop',
          def.pm2Name
        ]);
      }

    } else if (action === 'delete') {
      if (exists) {
        await runPm2([
          'delete',
          def.pm2Name
        ]);
      }
    }

    console.log(
      `[PM2管理] ${def.pm2Name} action=${action}`
    );

    res.json({
      success: true,
      key: def.key,
      action
    });

  } catch (error) {
    console.error('[PM2] 操作失败：', error);

    res.status(500).json({
      success: false,
      message:
        error.message
        + (error.stderr
          ? ' | ' + String(error.stderr).trim()
          : '')
    });
  }
});

app.get('/api/admin/scripts/:key/logs', checkAdmin, async (req, res) => {
  try {
    const def =
      getScriptDefinition(
        req.params.key
      );

    if (!def) {
      return res.status(404).json({
        success: false,
        message: '未知脚本'
      });
    }

    const lines =
      Math.min(
        300,
        Math.max(
          20,
          Number(req.query.lines) || 100
        )
      );

    const result =
      await runPm2([
        'logs',
        def.pm2Name,
        '--nostream',
        '--lines',
        String(lines)
      ]);

    res.json({
      success: true,
      key: def.key,
      pm2Name: def.pm2Name,
      text:
        [
          result.stdout,
          result.stderr
        ]
          .filter(Boolean)
          .join('\n')
          .trim()
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message:
        error.message
        + (
          error.stderr
            ? ' | ' + String(error.stderr).trim()
            : ''
        )
    });
  }
});


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
  /*
   * SuperLike 页面包含 moved / black_fan 等多人实时状态。
   * 这里禁止浏览器和 Cloudflare 缓存，避免自动刷新拿到旧状态，
   * 把 SSE 已经更新的画面重新覆盖回去。
   */
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, max-age=0'
  );
  res.setHeader(
    'Cloudflare-CDN-Cache-Control',
    'no-store'
  );
  res.setHeader(
    'CDN-Cache-Control',
    'no-store'
  );

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

    let data = db.prepare(`
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
        CASE
          WHEN sp.initial_experience_7d IS NULL THEN NULL
          WHEN sp.initial_experience_7d >= 80 THEN 0
          WHEN COALESCE(sp.initial_comments_count, 0) < 5 THEN
            CASE
              WHEN sp.initial_experience_7d + 1 >= 80
                THEN 5 - COALESCE(sp.initial_comments_count, 0)
              WHEN sp.initial_experience_7d + 3 >= 80
                THEN 10 - COALESCE(sp.initial_comments_count, 0)
              WHEN sp.initial_experience_7d + 6 >= 80
                THEN 15 - COALESCE(sp.initial_comments_count, 0)
              WHEN sp.initial_experience_7d + 10 >= 80
                THEN 20 - COALESCE(sp.initial_comments_count, 0)
              ELSE -1
            END
          WHEN COALESCE(sp.initial_comments_count, 0) < 10 THEN
            CASE
              WHEN sp.initial_experience_7d + 2 >= 80
                THEN 10 - COALESCE(sp.initial_comments_count, 0)
              WHEN sp.initial_experience_7d + 5 >= 80
                THEN 15 - COALESCE(sp.initial_comments_count, 0)
              WHEN sp.initial_experience_7d + 9 >= 80
                THEN 20 - COALESCE(sp.initial_comments_count, 0)
              ELSE -1
            END
          WHEN COALESCE(sp.initial_comments_count, 0) < 15 THEN
            CASE
              WHEN sp.initial_experience_7d + 3 >= 80
                THEN 15 - COALESCE(sp.initial_comments_count, 0)
              WHEN sp.initial_experience_7d + 7 >= 80
                THEN 20 - COALESCE(sp.initial_comments_count, 0)
              ELSE -1
            END
          WHEN COALESCE(sp.initial_comments_count, 0) < 20 THEN
            CASE
              WHEN sp.initial_experience_7d + 4 >= 80
                THEN 20 - COALESCE(sp.initial_comments_count, 0)
              ELSE -1
            END
          ELSE -1
        END AS comments_needed_for_80,
        sp.post_created_at,
        sp.inserted_at,
        sp.first_seen_at,
        sp.last_seen_at,
        sp.profile_status,
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM black_fan_users bfu
            WHERE TRIM(CAST(bfu.uid AS TEXT)) =
                  TRIM(CAST(sp.uid AS TEXT))
          )
          THEN 1
          ELSE 0
        END AS black_fan_flg
      FROM superlike_posts sp
      LEFT JOIN monitors m ON m.id=sp.monitor_id
      ${whereSql}
      ORDER BY
        /*
         * “最容易成为超LIKE”优先：
         * 排序固定使用“入库时经验值 + 入库时评论数”，不受 Mode2/Mode3 后续实时更新影响；
         * 还需要新增多少评论才能跨过后续 5/10/15/20 评论门槛，
         * 使经验值达到 80。
         *
         * 普通每日原创评论经验：
         * 5人 +1、10人再+2、15人再+3、20人再+4，累计最多10分。
         */
        CASE
          WHEN sp.initial_experience_7d IS NULL THEN 999999
          WHEN sp.initial_experience_7d >= 80 THEN 0

          /* 当前 <5：未来依次可在5/10/15/20获得 +1/+2/+3/+4 */
          WHEN COALESCE(sp.initial_comments_count, 0) < 5 THEN
            CASE
              WHEN sp.initial_experience_7d + 1 >= 80
                THEN 5 - COALESCE(sp.initial_comments_count, 0)
              WHEN sp.initial_experience_7d + 3 >= 80
                THEN 10 - COALESCE(sp.initial_comments_count, 0)
              WHEN sp.initial_experience_7d + 6 >= 80
                THEN 15 - COALESCE(sp.initial_comments_count, 0)
              WHEN sp.initial_experience_7d + 10 >= 80
                THEN 20 - COALESCE(sp.initial_comments_count, 0)
              ELSE 999998
            END

          /* 当前5-9：5人档已体现在实时jyz，只算未来 +2/+3/+4 */
          WHEN COALESCE(sp.initial_comments_count, 0) < 10 THEN
            CASE
              WHEN sp.initial_experience_7d + 2 >= 80
                THEN 10 - COALESCE(sp.initial_comments_count, 0)
              WHEN sp.initial_experience_7d + 5 >= 80
                THEN 15 - COALESCE(sp.initial_comments_count, 0)
              WHEN sp.initial_experience_7d + 9 >= 80
                THEN 20 - COALESCE(sp.initial_comments_count, 0)
              ELSE 999998
            END

          /* 当前10-14：10人档也已体现在实时jyz，只算未来 +3/+4 */
          WHEN COALESCE(sp.initial_comments_count, 0) < 15 THEN
            CASE
              WHEN sp.initial_experience_7d + 3 >= 80
                THEN 15 - COALESCE(sp.initial_comments_count, 0)
              WHEN sp.initial_experience_7d + 7 >= 80
                THEN 20 - COALESCE(sp.initial_comments_count, 0)
              ELSE 999998
            END

          /* 当前15-19：只剩20人档 +4 */
          WHEN COALESCE(sp.initial_comments_count, 0) < 20 THEN
            CASE
              WHEN sp.initial_experience_7d + 4 >= 80
                THEN 20 - COALESCE(sp.initial_comments_count, 0)
              ELSE 999998
            END

          ELSE 999998
        END ASC,

        /* 同样需要相同新增评论数时，入库jyz更高的优先 */
        CASE
          WHEN sp.initial_experience_7d IS NULL THEN 1
          ELSE 0
        END ASC,
        sp.initial_experience_7d DESC,

        /* 再相同时，入库评论数更接近下一档的优先 */
        COALESCE(sp.initial_comments_count, 0) DESC,
        datetime(sp.post_created_at) DESC,
        sp.id DESC
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

    if (deleted > 0) {
      addSuperLikePoolExitCount(1);
    }

    console.log(
      `[SuperLike][人工确认] UID=${uid} 已标记SuperLike | ` +
      `${inserted ? '新增用户' : '用户已存在'} | 删除候选=${deleted} | 今日毕业+${deleted > 0 ? 1 : 0}`
    );

    broadcastSuperLikeEvent(
      'user_removed',
      {
        uid,
        reason:
          'SUPERLIKE'
      }
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

    broadcastSuperLikeEvent(
      'black_fan',
      {
        uid,
        username:
          username || ''
      }
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

    broadcastSuperLikeMoved(
      [id],
      moved
    );

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

    broadcastSuperLikeMoved(
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

  app.listen(PORT, HOST, () => {
    console.log('====================================');
    console.log('Weibo Emoji Monitor');
    console.log(`Environment: ${APP_ENV.toUpperCase()}`);
    console.log(`Listen: ${HOST}:${PORT}`);
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
