'use strict';

const DEFAULT_COMMENT = '#田栩宁[超话]##微博星宝养成计划##微博星宝#泥嚎～交个朋友吧 ​';

function normalizeCommentCopies(value) {
  const input = Array.isArray(value) ? value : [];
  const copies = Array.from(new Set(
    input.map(item => String(item || '').trim()).filter(Boolean)
  )).slice(0, 50);
  return copies.length ? copies : [DEFAULT_COMMENT];
}

function normalizeWorkerId(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'default';
  return raw.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 120) || 'default';
}

let currentCommentCopies = [DEFAULT_COMMENT];
try {
  if (process.env.COMMENT_TEXTS_JSON) {
    currentCommentCopies = normalizeCommentCopies(JSON.parse(process.env.COMMENT_TEXTS_JSON));
  }
} catch (_) {}

let storeDb = null;
function getStoreDb() {
  if (storeDb) return storeDb;
  const dbModule = require('../../src/db');
  storeDb = dbModule.db;
  try { dbModule.initDatabase(); } catch (_) {}
  storeDb.exec(`CREATE TABLE IF NOT EXISTS comment_assistant_worker_comment_copies (
    worker_id TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    comment_text TEXT NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT LOCALTIMESTAMP,
    PRIMARY KEY (worker_id, sort_order)
  )`);
  return storeDb;
}

function loadWorkerCopies(workerId) {
  const worker = normalizeWorkerId(workerId);
  try {
    const rows = getStoreDb().prepare(`SELECT comment_text
      FROM comment_assistant_worker_comment_copies
      WHERE worker_id = ?
      ORDER BY sort_order ASC`).all(worker);
    const values = rows.map(row => String(row.comment_text || '').trim()).filter(Boolean);
    return values.length ? normalizeCommentCopies(values) : [DEFAULT_COMMENT];
  } catch (error) {
    console.warn(`[评论文案] 读取 worker=${worker} 文案失败：${error.message}`);
    return [DEFAULT_COMMENT];
  }
}

function saveWorkerCopies(workerId, value) {
  const worker = normalizeWorkerId(workerId);
  const copies = normalizeCommentCopies(value);
  const db = getStoreDb();
  // PostgreSQL compatibility bridge 没有 db.transaction()，这里保持同步顺序写入。
  db.prepare('DELETE FROM comment_assistant_worker_comment_copies WHERE worker_id = ?').run(worker);
  const insert = db.prepare(`INSERT INTO comment_assistant_worker_comment_copies
    (worker_id, sort_order, comment_text, updated_at)
    VALUES (?, ?, ?, LOCALTIMESTAMP)`);
  copies.forEach((text, index) => insert.run(worker, index, text));
  console.log(`[评论文案] worker=${worker} 已保存 ${copies.length} 条文案`);
  return copies;
}

try {
  const express = require('express');
  const originalUse = express.application.use;
  let middlewareInstalled = false;

  express.application.use = function patchedUse(...args) {
    const result = originalUse.apply(this, args);
    if (middlewareInstalled) return result;
    middlewareInstalled = true;

    originalUse.call(this, (req, res, next) => {
      if (!/^\/api\/comment-copies(?:\?|$)/.test(String(req.originalUrl || req.url || ''))) return next();

      const token = String(process.env.COMMENT_API_TOKEN || '').trim();
      const auth = String(req.headers?.authorization || '');
      if (!token || auth !== `Bearer ${token}`) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      try {
        const worker = normalizeWorkerId(req.method === 'GET' ? req.query?.worker : req.body?.worker);
        if (req.method === 'GET') {
          return res.json({ success: true, data: { worker, copies: loadWorkerCopies(worker) } });
        }
        if (req.method === 'PUT' || req.method === 'POST') {
          const copies = saveWorkerCopies(worker, req.body?.copies);
          return res.json({ success: true, data: { worker, copies } });
        }
        return res.status(405).json({ success: false, message: 'Method Not Allowed' });
      } catch (error) {
        console.error(`[评论文案] API失败：${error.message}`);
        return res.status(400).json({ success: false, message: error.message });
      }
    });
    return result;
  };
} catch (_) {}

const childProcess = require('child_process');
const originalSpawn = childProcess.spawn;
childProcess.spawn = function patchedSpawn(command, args, options) {
  const argv = Array.isArray(args) ? args : [];
  const isCommentWorker = argv.some(value => /comment-assistant[\\/]index-http\.js$/i.test(String(value)));
  if (!isCommentWorker) return originalSpawn.apply(this, arguments);

  const nextOptions = options || {};
  const workerId = normalizeWorkerId(nextOptions.env?.COMMENT_WORKER_ID || 'default');
  const workerCopies = loadWorkerCopies(workerId);
  const existingNodeOptions = String(nextOptions.env?.NODE_OPTIONS || process.env.NODE_OPTIONS || '').trim();
  const preloadOption = `--require=${__filename}`;
  nextOptions.env = {
    ...process.env,
    ...(nextOptions.env || {}),
    COMMENT_TEXTS_JSON: JSON.stringify(workerCopies),
    NODE_OPTIONS: [existingNodeOptions, preloadOption].filter(Boolean).join(' ')
  };

  console.log(`[评论文案] 启动 worker=${workerId} 账号任务：数据库载入 ${workerCopies.length} 条随机文案`);
  return originalSpawn.call(this, command, args, nextOptions);
};

try {
  const express = require('express');
  const originalPost = express.application.post;
  express.application.post = function patchedPost(route, ...handlers) {
    const routeText = String(route || '');
    const isClaimRoute = /^\/api\/(?:tasks\/claim|tasks\/[^/]+\/claim)$/.test(routeText);
    if (!isClaimRoute) return originalPost.call(this, route, ...handlers);

    const captureCommentCopies = (req, res, next) => {
      if (Array.isArray(req.body?.comment_copies)) {
        const worker = normalizeWorkerId(req.body?.worker || 'default');
        try { saveWorkerCopies(worker, req.body.comment_copies); } catch (error) {
          console.warn(`[评论文案] 领取任务前保存失败：${error.message}`);
        }
      }
      next();
    };
    return originalPost.call(this, route, captureCommentCopies, ...handlers);
  };
} catch (_) {}

if (/index-http\.js$/i.test(String(process.argv[1] || ''))) {
  try {
    const commentAutoModule = require('./comment-auto-service');
    const originalCreate = commentAutoModule.createCommentAutoService;

    if (typeof originalCreate === 'function' && !originalCreate.__randomCopyWrapped) {
      const wrappedCreate = function createRandomCommentService(options = {}) {
        const service = originalCreate({ ...options, defaultComment: DEFAULT_COMMENT });
        const originalSubmit = service.submitComment.bind(service);

        service.submitComment = payload => {
          const copies = currentCommentCopies.length ? currentCommentCopies : [DEFAULT_COMMENT];
          const selected = copies[Math.floor(Math.random() * copies.length)] || DEFAULT_COMMENT;
          console.log(`[评论文案] 随机 ${copies.length} 条中的 1 条：${selected}`);
          return originalSubmit({ ...payload, commentText: selected });
        };
        return service;
      };

      wrappedCreate.__randomCopyWrapped = true;
      commentAutoModule.createCommentAutoService = wrappedCreate;
    }
  } catch (error) {
    console.warn(`[评论文案] Runtime加载失败：${error.message}`);
  }
}
