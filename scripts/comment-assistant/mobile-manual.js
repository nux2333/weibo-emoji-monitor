'use strict';

const express = require('express');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { db, initDatabase } = require('../../src/db');

const HOST = String(process.env.COMMENT_MOBILE_HOST || '127.0.0.1');
const PORT = Number(process.env.COMMENT_MOBILE_PORT || 3014);
const TOKEN = String(process.env.COMMENT_API_TOKEN || '').trim();
const PAGE_FILE = path.join(__dirname, 'mobile-manual.html');
const WORKER_ID = 'default';
const DEFAULT_ACCOUNT = 'mobile';
const DEFAULT_TASK_ID = 'builtin-random-high-exp';
const DEFAULT_TASK_NAME = '随机高经验值用户轮询';
const DEFAULT_TASK_COUNT = 20;

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

function sanitizeAccount(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const safe = raw.replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 80);
  return safe || null;
}

function makeTaskId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function listAccounts() {
  const assignmentRows = db.prepare(`SELECT account, MAX(claimed_at) AS last_seen
    FROM comment_assistant_task_assignments
    WHERE account IS NOT NULL AND account <> ''
    GROUP BY account`).all();

  const historyRows = db.prepare(`SELECT account, MAX(commented_at) AS last_seen
    FROM comment_assistant_history
    WHERE account IS NOT NULL AND account <> ''
    GROUP BY account`).all();

  const seen = new Map();
  for (const row of [...assignmentRows, ...historyRows]) {
    const account = String(row.account || '').trim();
    if (!account) continue;
    const time = row.last_seen == null ? '' : String(row.last_seen);
    const prev = seen.get(account);
    if (!prev || time > prev) seen.set(account, time);
  }

  const names = Array.from(seen.entries())
    .sort((a, b) => String(b[1]).localeCompare(String(a[1])))
    .map(([account]) => account);

  if (!names.includes(DEFAULT_ACCOUNT)) names.unshift(DEFAULT_ACCOUNT);
  return names;
}

function claimDefaultTask(account) {
  const targetAccount = sanitizeAccount(account) || DEFAULT_ACCOUNT;
  const existingPending = db.prepare(`SELECT COUNT(*) AS cnt
    FROM comment_assistant_task_assignments
    WHERE worker_id = ? AND account = ? AND status = 'CLAIMED'`).get(WORKER_ID, targetAccount);
  const pending = Number(existingPending?.cnt || 0);
  const need = Math.max(0, DEFAULT_TASK_COUNT - pending);
  if (!need) return { account: targetAccount, count: 0, pending, target: DEFAULT_TASK_COUNT };

  const candidates = db.prepare(`SELECT sp.post_id, sp.uid, sp.username, sp.post_link, sp.post_text,
      sp.experience_7d, sp.comments_count
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
      AND NOT EXISTS (
        SELECT 1 FROM comment_assistant_tasks t
        JOIN comment_assistant_task_assignments a ON a.task_id = t.task_id
        WHERE a.worker_id = ?
          AND a.account = ?
          AND a.status = 'CLAIMED'
          AND t.post_id = CAST(sp.post_id AS TEXT)
      )
    ORDER BY RANDOM()
    LIMIT ?`).all(targetAccount, WORKER_ID, targetAccount, Math.max(need * 5, 100));

  let count = 0;
  for (const candidate of candidates) {
    if (count >= need) break;
    const taskId = makeTaskId();
    const note = `${DEFAULT_TASK_NAME} | 经验值=${candidate.experience_7d ?? '-'} | UID=${candidate.uid || '-'}`;
    try {
      db.prepare(`INSERT INTO comment_assistant_tasks
        (task_id, post_id, post_link, post_text, note, priority, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, 'CLAIMED', ?, LOCALTIMESTAMP, LOCALTIMESTAMP)`).run(
          taskId,
          String(candidate.post_id),
          candidate.post_link,
          candidate.post_text || null,
          note,
          DEFAULT_TASK_ID
        );
      db.prepare(`INSERT INTO comment_assistant_task_assignments
        (task_id, worker_id, account, status, claimed_at)
        VALUES (?, ?, ?, 'CLAIMED', LOCALTIMESTAMP)`).run(taskId, WORKER_ID, targetAccount);
      count += 1;
    } catch (_) {
      // Skip duplicate/race and continue filling the queue.
    }
  }

  return { account: targetAccount, count, pending: pending + count, target: DEFAULT_TASK_COUNT };
}

app.get('/api/health', auth, (req, res) => {
  res.json({ success: true, data: {
    host: os.hostname(),
    now: new Date().toISOString(),
    worker: WORKER_ID,
    default_task: DEFAULT_TASK_NAME
  }});
});

app.get('/api/accounts', auth, (req, res) => {
  const accounts = listAccounts();
  const rows = accounts.map(account => {
    const stats = db.prepare(`SELECT
        COUNT(*) AS total_count,
        SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) AS done_count,
        SUM(CASE WHEN status = 'SKIPPED' THEN 1 ELSE 0 END) AS skipped_count,
        SUM(CASE WHEN status = 'CLAIMED' THEN 1 ELSE 0 END) AS pending_count
      FROM comment_assistant_task_assignments
      WHERE worker_id = ? AND account = ?`).get(WORKER_ID, account);
    return { account, ...stats };
  });
  res.json({ success: true, data: rows });
});

app.post('/api/default-task/claim', auth, (req, res) => {
  try {
    const account = sanitizeAccount(req.body?.account) || DEFAULT_ACCOUNT;
    res.json({ success: true, data: claimDefaultTask(account) });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.get('/api/next', auth, (req, res) => {
  const account = sanitizeAccount(req.query.account) || DEFAULT_ACCOUNT;

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
    LIMIT 1`).get(WORKER_ID, account);

  const progress = db.prepare(`SELECT
      COUNT(*) AS total_count,
      SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) AS done_count,
      SUM(CASE WHEN status = 'SKIPPED' THEN 1 ELSE 0 END) AS skipped_count,
      SUM(CASE WHEN status = 'CLAIMED' THEN 1 ELSE 0 END) AS pending_count
    FROM comment_assistant_task_assignments
    WHERE worker_id = ? AND account = ?`).get(WORKER_ID, account);

  res.json({ success: true, data: { task: task || null, progress } });
});

app.post('/api/task/:taskId/result', auth, (req, res) => {
  const taskId = String(req.params.taskId || '').trim();
  const account = sanitizeAccount(req.body?.account) || DEFAULT_ACCOUNT;
  const action = String(req.body?.action || '').trim().toLowerCase();
  const manualText = String(req.body?.manual_text || '').trim().slice(0, 500);

  if (!taskId) return res.status(400).json({ success: false, message: 'taskId required' });
  if (!['done', 'skip'].includes(action)) {
    return res.status(400).json({ success: false, message: 'action must be done or skip' });
  }

  const row = db.prepare(`SELECT task_id, status
    FROM comment_assistant_task_assignments
    WHERE task_id = ? AND worker_id = ? AND account = ?`).get(taskId, WORKER_ID, account);

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
    .run(status, result, taskId, WORKER_ID, account);

  db.prepare(`UPDATE comment_assistant_tasks
    SET status = ?, updated_at = LOCALTIMESTAMP
    WHERE task_id = ?`).run(status, taskId);

  if (status === 'DONE') {
    const task = db.prepare('SELECT post_id FROM comment_assistant_tasks WHERE task_id = ?').get(taskId);
    if (task?.post_id) {
      try {
        db.prepare(`INSERT INTO comment_assistant_history (account, post_id, commented_at)
          VALUES (?, ?, LOCALTIMESTAMP)
          ON CONFLICT (account, post_id) DO NOTHING`).run(account, String(task.post_id));
      } catch (_) {
        // Older DB adapters may not support ON CONFLICT syntax; task result is already persisted.
      }
    }
  }

  res.json({ success: true, data: { task_id: taskId, status } });
});

app.get('/', (req, res) => {
  res.sendFile(PAGE_FILE);
});

app.listen(PORT, HOST, () => {
  console.log(`[Comment Assistant Mobile] http://${HOST}:${PORT}/`);
  console.log(`[Comment Assistant Mobile] Worker=${WORKER_ID} | 默认任务=${DEFAULT_TASK_NAME} | 队列=${DEFAULT_TASK_COUNT}`);
});
