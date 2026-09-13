'use strict';

const express = require('express');
const os = require('os');
const crypto = require('crypto');
const { db, initDatabase } = require('../../src/db');

const HOST = String(process.env.COMMENT_REMOTE_API_HOST || '127.0.0.1');
const PORT = Number(process.env.COMMENT_REMOTE_API_PORT || 3013);
const TOKEN = String(process.env.COMMENT_API_TOKEN || '').trim();
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 20;

if (!TOKEN) {
  console.error('[Comment Remote API] COMMENT_API_TOKEN 未设置，拒绝启动。');
  process.exit(1);
}

initDatabase();

db.exec(`CREATE TABLE IF NOT EXISTS comment_assistant_history (
  account TEXT NOT NULL,
  post_id TEXT NOT NULL,
  commented_at TIMESTAMP NOT NULL DEFAULT LOCALTIMESTAMP,
  PRIMARY KEY (account, post_id)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS comment_assistant_tasks (
  task_id TEXT PRIMARY KEY,
  post_id TEXT,
  post_link TEXT NOT NULL,
  post_text TEXT,
  note TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_by TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT LOCALTIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT LOCALTIMESTAMP
)`);

db.exec(`CREATE TABLE IF NOT EXISTS comment_assistant_task_assignments (
  task_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  account TEXT,
  status TEXT NOT NULL DEFAULT 'CLAIMED',
  claimed_at TIMESTAMP NOT NULL DEFAULT LOCALTIMESTAMP,
  completed_at TIMESTAMP,
  result TEXT
)`);

const app = express();
app.use(express.json({ limit: '64kb' }));

function bearer(req) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
}

function auth(req, res, next) {
  if (bearer(req) !== TOKEN) return res.status(401).json({ success: false, message: 'unauthorized' });
  next();
}

function clean(value, max = 120) {
  return String(value || '').trim().slice(0, max);
}

function sanitizeAccount(value) {
  const raw = clean(value, 80);
  if (!raw) return '';
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function makeTaskId() {
  return `remote-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function claimCandidates(worker, account, limit) {
  const poolSize = Math.max(limit * 8, 100);
  const candidates = db.prepare(`SELECT
      sp.post_id,
      sp.uid,
      sp.username,
      sp.post_link,
      sp.post_text,
      sp.experience_7d,
      sp.comments_count,
      sp.post_created_at
    FROM superlike_posts sp
    WHERE COALESCE(sp.current_has_superlike, 0) = 0
      AND sp.experience_7d IS NOT NULL
      AND sp.experience_7d >= 70
      AND COALESCE(sp.comments_count, 0) <= 19
      AND sp.post_link IS NOT NULL
      AND CAST(sp.post_created_at AS date) = CAST(LOCALTIMESTAMP AS date)
      AND NOT EXISTS (
        SELECT 1 FROM black_fan_users b
        WHERE CAST(b.uid AS TEXT) = CAST(sp.uid AS TEXT)
      )
      AND NOT EXISTS (
        SELECT 1 FROM comment_assistant_history h
        WHERE h.account = ? AND h.post_id = CAST(sp.post_id AS TEXT)
      )
    ORDER BY RANDOM()
    LIMIT ?`).all(account, poolSize);

  const claimed = [];
  for (const row of candidates) {
    if (claimed.length >= limit) break;

    const existing = db.prepare(`SELECT 1 AS yes
      FROM comment_assistant_task_assignments a
      JOIN comment_assistant_tasks t ON t.task_id = a.task_id
      WHERE a.worker_id = ?
        AND a.account = ?
        AND t.post_id = ?
        AND a.status = 'CLAIMED'
      LIMIT 1`).get(worker, account, String(row.post_id));
    if (existing) continue;

    const taskId = makeTaskId();
    const note = `随机高经验值用户轮询 | 经验值=${row.experience_7d ?? '-'} | UID=${row.uid || '-'}`;

    try {
      db.prepare(`INSERT INTO comment_assistant_tasks
        (task_id, post_id, post_link, post_text, note, priority, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, 'CLAIMED', 'remote-default', LOCALTIMESTAMP, LOCALTIMESTAMP)`).run(
          taskId,
          String(row.post_id),
          row.post_link,
          row.post_text || null,
          note
        );
      db.prepare(`INSERT INTO comment_assistant_task_assignments
        (task_id, worker_id, account, status, claimed_at)
        VALUES (?, ?, ?, 'CLAIMED', LOCALTIMESTAMP)`).run(taskId, worker, account);

      claimed.push({
        task_id: taskId,
        post_id: String(row.post_id),
        uid: row.uid == null ? null : String(row.uid),
        username: row.username || null,
        post_link: row.post_link,
        post_text: row.post_text || '',
        experience_7d: row.experience_7d,
        comments_count: row.comments_count,
        post_created_at: row.post_created_at,
        account
      });
    } catch (_) {}
  }

  return claimed;
}

app.get('/api/health', auth, (req, res) => {
  res.json({ success: true, data: { host: os.hostname(), now: new Date().toISOString() } });
});

app.post('/api/default-task/claim', auth, (req, res) => {
  try {
    const worker = clean(req.body?.worker);
    const account = sanitizeAccount(req.body?.account);
    const requested = Number(req.body?.limit || DEFAULT_LIMIT);
    const limit = Math.max(1, Math.min(Number.isFinite(requested) ? requested : DEFAULT_LIMIT, MAX_LIMIT));
    if (!worker) return res.status(400).json({ success: false, message: 'worker required' });
    if (!account) return res.status(400).json({ success: false, message: 'account required' });

    const items = claimCandidates(worker, account, limit);
    res.json({
      success: true,
      data: {
        task_name: '随机高经验值用户轮询',
        worker,
        account,
        target_count: limit,
        count: items.length,
        items
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.post('/api/tasks/:taskId/result', auth, (req, res) => {
  try {
    const taskId = clean(req.params.taskId, 180);
    const worker = clean(req.body?.worker);
    const status = clean(req.body?.status, 20).toUpperCase();
    const result = clean(req.body?.result, 500);
    if (!worker || !taskId) return res.status(400).json({ success: false, message: 'worker/taskId required' });
    if (!['DONE', 'SKIPPED'].includes(status)) {
      return res.status(400).json({ success: false, message: 'status must be DONE or SKIPPED' });
    }

    const assignment = db.prepare(`SELECT a.account, t.post_id
      FROM comment_assistant_task_assignments a
      JOIN comment_assistant_tasks t ON t.task_id = a.task_id
      WHERE a.task_id = ? AND a.worker_id = ?`).get(taskId, worker);
    if (!assignment) return res.status(404).json({ success: false, message: '任务不属于当前 Worker' });

    db.prepare(`UPDATE comment_assistant_task_assignments
      SET status = ?, result = ?, completed_at = LOCALTIMESTAMP
      WHERE task_id = ? AND worker_id = ?`).run(status, result, taskId, worker);
    db.prepare(`UPDATE comment_assistant_tasks
      SET status = ?, updated_at = LOCALTIMESTAMP
      WHERE task_id = ?`).run(status, taskId);

    if (status === 'DONE' && assignment.post_id) {
      try {
        db.prepare(`INSERT INTO comment_assistant_history (account, post_id, commented_at)
          VALUES (?, ?, LOCALTIMESTAMP)
          ON CONFLICT (account, post_id) DO NOTHING`).run(assignment.account, String(assignment.post_id));
      } catch (_) {}
    }

    res.json({ success: true, data: { task_id: taskId, status } });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.post('/api/tasks/interrupt', auth, (req, res) => {
  try {
    const worker = clean(req.body?.worker);
    const account = sanitizeAccount(req.body?.account);
    if (!worker || !account) return res.status(400).json({ success: false, message: 'worker/account required' });

    const rows = db.prepare(`SELECT task_id FROM comment_assistant_task_assignments
      WHERE worker_id = ? AND account = ? AND status = 'CLAIMED'`).all(worker, account);

    db.prepare(`UPDATE comment_assistant_task_assignments
      SET status = 'SKIPPED', result = '客户端中断', completed_at = LOCALTIMESTAMP
      WHERE worker_id = ? AND account = ? AND status = 'CLAIMED'`).run(worker, account);

    for (const row of rows) {
      db.prepare(`UPDATE comment_assistant_tasks
        SET status = 'SKIPPED', updated_at = LOCALTIMESTAMP
        WHERE task_id = ? AND status = 'CLAIMED'`).run(row.task_id);
    }

    res.json({ success: true, data: { account, interrupted: rows.length } });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`[Comment Remote API] http://${HOST}:${PORT}`);
  console.log('[Comment Remote API] default task: 随机高经验值用户轮询 / max 20');
  console.log('[Comment Remote API] manual status only; no automatic comment submission or proxy rotation');
});
