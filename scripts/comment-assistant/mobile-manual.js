'use strict';

const express = require('express');
const os = require('os');
const path = require('path');
const { db, initDatabase } = require('../../src/db');

const HOST = String(process.env.COMMENT_MOBILE_HOST || '127.0.0.1');
const PORT = Number(process.env.COMMENT_MOBILE_PORT || 3014);
const TOKEN = String(process.env.COMMENT_API_TOKEN || '').trim();
const PAGE_FILE = path.join(__dirname, 'mobile-manual.html');

if (!TOKEN) {
  console.error('[Comment Assistant Mobile] COMMENT_API_TOKEN 未设置，拒绝启动。');
  process.exit(1);
}

initDatabase();

const app = express();
app.use(express.json({ limit: '64kb' }));

function bearer(req) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
}

function auth(req, res, next) {
  if (bearer(req) !== TOKEN) {
    return res.status(401).json({ success: false, message: 'unauthorized' });
  }
  next();
}

function workerKey(value) {
  return String(value || '').trim().slice(0, 120);
}

function sanitizeAccount(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const safe = raw.replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 80);
  return safe || null;
}

app.get('/api/health', auth, (req, res) => {
  res.json({ success: true, data: { host: os.hostname(), now: new Date().toISOString() } });
});

app.get('/api/accounts', auth, (req, res) => {
  const worker = workerKey(req.query.worker);
  if (!worker) return res.status(400).json({ success: false, message: 'worker required' });

  const rows = db.prepare(`SELECT
      a.account,
      COUNT(*) AS total_count,
      SUM(CASE WHEN a.status = 'DONE' THEN 1 ELSE 0 END) AS done_count,
      SUM(CASE WHEN a.status = 'SKIPPED' THEN 1 ELSE 0 END) AS skipped_count,
      SUM(CASE WHEN a.status = 'CLAIMED' THEN 1 ELSE 0 END) AS pending_count
    FROM comment_assistant_task_assignments a
    WHERE a.worker_id = ?
    GROUP BY a.account
    ORDER BY MAX(a.claimed_at) DESC`).all(worker);

  res.json({ success: true, data: rows });
});

app.get('/api/next', auth, (req, res) => {
  const worker = workerKey(req.query.worker);
  const account = sanitizeAccount(req.query.account);
  if (!worker || !account) {
    return res.status(400).json({ success: false, message: 'worker/account required' });
  }

  const task = db.prepare(`SELECT
      a.task_id,
      a.account,
      a.claimed_at,
      t.post_id,
      t.post_link,
      t.post_text,
      t.note
    FROM comment_assistant_task_assignments a
    JOIN comment_assistant_tasks t ON t.task_id = a.task_id
    WHERE a.worker_id = ?
      AND a.account = ?
      AND a.status = 'CLAIMED'
    ORDER BY a.claimed_at ASC
    LIMIT 1`).get(worker, account);

  const progress = db.prepare(`SELECT
      COUNT(*) AS total_count,
      SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) AS done_count,
      SUM(CASE WHEN status = 'SKIPPED' THEN 1 ELSE 0 END) AS skipped_count,
      SUM(CASE WHEN status = 'CLAIMED' THEN 1 ELSE 0 END) AS pending_count
    FROM comment_assistant_task_assignments
    WHERE worker_id = ? AND account = ?`).get(worker, account);

  res.json({ success: true, data: { task: task || null, progress } });
});

app.post('/api/task/:taskId/result', auth, (req, res) => {
  const taskId = String(req.params.taskId || '').trim();
  const worker = workerKey(req.body?.worker);
  const account = sanitizeAccount(req.body?.account);
  const action = String(req.body?.action || '').trim().toLowerCase();
  const manualText = String(req.body?.manual_text || '').trim().slice(0, 500);

  if (!taskId || !worker || !account) {
    return res.status(400).json({ success: false, message: 'taskId/worker/account required' });
  }
  if (!['done', 'skip'].includes(action)) {
    return res.status(400).json({ success: false, message: 'action must be done or skip' });
  }

  const row = db.prepare(`SELECT task_id, status
    FROM comment_assistant_task_assignments
    WHERE task_id = ? AND worker_id = ? AND account = ?`).get(taskId, worker, account);

  if (!row) return res.status(404).json({ success: false, message: '任务不存在' });
  if (row.status !== 'CLAIMED') {
    return res.status(409).json({ success: false, message: `当前状态=${row.status}，不能重复处理` });
  }

  const status = action === 'done' ? 'DONE' : 'SKIPPED';
  const result = action === 'done'
    ? `手机端手动确认完成${manualText ? ` | ${manualText}` : ''}`
    : `手机端手动跳过${manualText ? ` | ${manualText}` : ''}`;

  db.prepare(`UPDATE comment_assistant_task_assignments
    SET status = ?, result = ?, completed_at = LOCALTIMESTAMP
    WHERE task_id = ? AND worker_id = ? AND account = ? AND status = 'CLAIMED'`)
    .run(status, result, taskId, worker, account);

  db.prepare(`UPDATE comment_assistant_tasks
    SET status = ?, updated_at = LOCALTIMESTAMP
    WHERE task_id = ?`).run(status, taskId);

  res.json({ success: true, data: { task_id: taskId, status } });
});

app.get('/', (req, res) => {
  res.sendFile(PAGE_FILE);
});

app.listen(PORT, HOST, () => {
  console.log(`[Comment Assistant Mobile] http://${HOST}:${PORT}/`);
  console.log('[Comment Assistant Mobile] Enter = 手动确认当前任务完成并进入下一条');
});
