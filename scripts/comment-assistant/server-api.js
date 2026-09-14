'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { db, initDatabase } = require('../../src/db');

const ROOT = path.join(__dirname, '..', '..');
const POSTGRES_PRELOAD = path.join(ROOT, 'src', 'postgres-preload.js');
const PROFILE_ROOT = path.join(ROOT, 'data', 'comment-assistant-profiles');
const LEGACY_PROFILE_DIR = path.join(ROOT, 'data', 'comment-assistant-profile');
const PUBLIC_DIR = path.join(__dirname, 'public');
const HOST = String(process.env.COMMENT_WORKER_API_HOST || '127.0.0.1');
const PORT = Number(process.env.COMMENT_WORKER_API_PORT || 3012);
const TOKEN = String(process.env.COMMENT_API_TOKEN || '').trim();
const ADMIN_TOKEN = String(process.env.COMMENT_ADMIN_TOKEN || '').trim();
const WORKER_TTL_MS = Math.max(30_000, Number(process.env.COMMENT_WORKER_TTL_MS || 2 * 60_000));
const DEFAULT_TASK_ID = 'builtin-random-high-exp';
const DEFAULT_TASK_NAME = '随机高经验值用户轮询';
const DEFAULT_WORKER_ID = 'default';
const TASK_TARGET_PER_ACCOUNT = 20;

if (!TOKEN) {
  console.error('[Comment Assistant] COMMENT_API_TOKEN 未设置，拒绝启动。');
  process.exit(1);
}

fs.mkdirSync(PROFILE_ROOT, { recursive: true });
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

db.exec(`CREATE TABLE IF NOT EXISTS comment_assistant_execution_logs (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id TEXT NOT NULL,
  account TEXT NOT NULL,
  task_id TEXT,
  post_id TEXT,
  post_link TEXT,
  round_no INTEGER,
  item_no INTEGER,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT LOCALTIMESTAMP
)`);

const app = express();
app.use(express.json({ limit: '128kb' }));
app.use('/static', express.static(PUBLIC_DIR));

const workers = new Map();

function sanitizeAccount(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const safe = raw.replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 80);
  return safe || null;
}

function accountProfileDir(account) {
  return account === 'default' ? LEGACY_PROFILE_DIR : path.join(PROFILE_ROOT, account);
}

function hasProfileData(profileDir) {
  if (!fs.existsSync(profileDir)) return false;
  return [
    path.join(profileDir, 'Default', 'Network', 'Cookies'),
    path.join(profileDir, 'Default', 'Cookies'),
    path.join(profileDir, 'Local State')
  ].some(file => fs.existsSync(file));
}

function readAccountMeta(profileDir) {
  const file = path.join(profileDir, 'account-meta.json');
  try {
    if (!fs.existsSync(file)) return {};
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      uid: data?.uid ? String(data.uid) : null,
      username: data?.username ? String(data.username).trim() : null
    };
  } catch (_) {
    return {};
  }
}

function accountInfo(name, profileDir, legacy) {
  const meta = readAccountMeta(profileDir);
  return {
    name,
    uid: meta.uid || null,
    username: name,
    legacy: Boolean(legacy),
    initialized: hasProfileData(profileDir)
  };
}

function listAccounts() {
  const result = [];
  if (fs.existsSync(LEGACY_PROFILE_DIR)) {
    result.push(accountInfo('default', LEGACY_PROFILE_DIR, true));
  }

  try {
    const names = fs
      .readdirSync(PROFILE_ROOT, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' }));

    for (const name of names) {
      result.push(accountInfo(name, path.join(PROFILE_ROOT, name), false));
    }
  } catch (error) {
    console.warn(`[Comment Assistant] 读取账号目录失败：${error.message}`);
  }

  return result;
}

function createAccount(name) {
  const safe = sanitizeAccount(name);
  if (!safe) throw new Error('账号名称不能为空');
  if (safe === 'default') throw new Error('default 为旧版保留名称，请换一个名字');

  const dir = path.join(PROFILE_ROOT, safe);
  if (fs.existsSync(dir)) throw new Error(`账号 ${safe} 已存在`);
  fs.mkdirSync(dir, { recursive: true });

  return { name: safe, uid: null, username: safe, legacy: false, initialized: false };
}

function deleteAccount(name) {
  const account = sanitizeAccount(name);
  if (!account) throw new Error('账号名称不能为空');
  if (account === 'default') throw new Error('default 为旧版保留账号，不支持在这里删除');

  const profileDir = accountProfileDir(account);
  if (!fs.existsSync(profileDir)) throw new Error(`账号 ${account} 不存在`);

  const assignments = db
    .prepare(`SELECT task_id, status
      FROM comment_assistant_task_assignments
      WHERE account = ?`)
    .all(account);

  for (const item of assignments) {
    if (item.status === 'CLAIMED' || item.status === 'SKIPPED') {
      db.prepare(`UPDATE comment_assistant_tasks
        SET status = 'OPEN', updated_at = LOCALTIMESTAMP
        WHERE task_id = ? AND status IN ('CLAIMED', 'SKIPPED')`).run(item.task_id);
    }
  }

  db.prepare('DELETE FROM comment_assistant_task_assignments WHERE account = ?').run(account);
  db.prepare('DELETE FROM comment_assistant_history WHERE account = ?').run(account);
  fs.rmSync(profileDir, { recursive: true, force: true });

  return { account, deleted: true, released_tasks: assignments.length };
}

function launchAccountLogin(name) {
  const account = sanitizeAccount(name);
  if (!account) throw new Error('账号名称不能为空');

  const profileDir = accountProfileDir(account);
  if (!fs.existsSync(profileDir)) throw new Error(`账号 ${account} 不存在`);

  const script = path.join(__dirname, 'account-login.js');
  const child = spawn(process.execPath, [script, account], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: { ...process.env, NODE_OPTIONS: '' }
  });
  child.unref();

  return { account, pid: child.pid };
}

function bearer(req) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
}

function userAuth(req, res, next) {
  if (bearer(req) !== TOKEN) {
    return res.status(401).json({ success: false, message: 'unauthorized' });
  }
  next();
}

function adminAuth(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({
      success: false,
      message: 'COMMENT_ADMIN_TOKEN 未设置，管理员功能未启用'
    });
  }
  if (bearer(req) !== ADMIN_TOKEN) {
    return res.status(401).json({ success: false, message: 'admin unauthorized' });
  }
  next();
}

function workerKey(value) {
  return String(value || '').trim().slice(0, 120);
}

function touchWorker(worker, patch = {}) {
  const key = workerKey(worker);
  if (!key) return null;

  const prev = workers.get(key) || {};
  const next = {
    worker: key,
    account: String(patch.account ?? prev.account ?? '').trim(),
    status: String(patch.status ?? prev.status ?? 'online').trim().slice(0, 80),
    note: String(patch.note ?? prev.note ?? '').trim().slice(0, 300),
    lastSeenAt: Date.now()
  };
  workers.set(key, next);
  return next;
}

function cleanupWorkers() {
  const now = Date.now();
  for (const [key, value] of workers) {
    if (!value || now - value.lastSeenAt > WORKER_TTL_MS) workers.delete(key);
  }
}

function makeTaskId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function normalizeStatus(value) {
  const status = String(value || '').toUpperCase();
  return ['OPEN', 'CLAIMED', 'DONE', 'SKIPPED', 'CANCELLED'].includes(status) ? status : null;
}

function availableTasks() {
  const rows = db
    .prepare(`SELECT task_id, post_id, post_link, post_text, note, priority, created_at
      FROM comment_assistant_tasks
      WHERE status = 'OPEN' AND COALESCE(created_by, '') <> ?
      ORDER BY priority DESC, created_at ASC
      LIMIT 200`)
    .all(DEFAULT_TASK_ID);

  return [
    {
      task_id: DEFAULT_TASK_ID,
      kind: 'builtin',
      name: DEFAULT_TASK_NAME,
      note: `每个已选账号每轮领取 ${TASK_TARGET_PER_ACCOUNT} 条随机高经验值帖子待处理队列。`,
      priority: 9999
    },
    ...rows.map(row => ({
      ...row,
      kind: 'post',
      name: row.post_text || row.post_id || row.post_link,
      note: row.note || ''
    }))
  ];
}

function spawnLoopExecutionForAccount(worker, account, loops = 1, intervalMinutes = 0) {
  const script = path.join(__dirname, 'index-http.js');
  const child = spawn(process.execPath, ['-r', POSTGRES_PRELOAD, script], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      COMMENT_ACCOUNT: account,
      COMMENT_ASSISTANT_PROFILE: accountProfileDir(account),
      COMMENT_TARGET_LIMIT: String(TASK_TARGET_PER_ACCOUNT),
      COMMENT_LOOP_MODE: '1',
      COMMENT_LOOP_COUNT: String(Math.max(1, Number(loops || 1))),
      COMMENT_LOOP_INTERVAL_MINUTES: String(Math.max(0, Number(intervalMinutes || 0))),
      COMMENT_WORKER_ID: worker
    }
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      console.warn(`[TaskLoop] 账号 ${account} 被信号 ${signal} 终止`);
      return;
    }
    console.log(`[TaskLoop] 账号 ${account} 退出 | code=${code ?? 0}`);
  });

  return child;
}

function claimBuiltinRandomHighExp(worker, accounts, loops, intervalMinutes = 0) {
  const targetCount = Math.min(accounts.length * TASK_TARGET_PER_ACCOUNT * loops, 2000);
  const poolSize = Math.max(targetCount * 8, 200);
  const candidates = db
    .prepare(`SELECT sp.post_id, sp.uid, sp.username, sp.post_link, sp.post_text,
        sp.experience_7d, sp.comments_count
      FROM superlike_posts sp
      WHERE COALESCE(sp.current_has_superlike, 0) = 0
        AND sp.experience_7d IS NOT NULL
        AND sp.experience_7d >= 70
        AND COALESCE(sp.comments_count, 0) <= 19
        AND sp.post_link IS NOT NULL
        AND NULLIF(TRIM(sp.post_created_at), '')::date = CURRENT_DATE
        AND NOT EXISTS (
          SELECT 1
          FROM black_fan_users b
          WHERE CAST(b.uid AS TEXT) = CAST(sp.uid AS TEXT)
        )
      ORDER BY RANDOM()
      LIMIT ?`)
    .all(poolSize);

  const claimed = [];
  const usedByAccount = new Map();
  for (const account of accounts) usedByAccount.set(account, new Set());

  let cursor = 0;
  while (claimed.length < targetCount && cursor < candidates.length * Math.max(1, accounts.length)) {
    const account = accounts[
      Math.floor(claimed.length / (TASK_TARGET_PER_ACCOUNT * loops)) % accounts.length
    ];
    const used = usedByAccount.get(account);
    let candidate = null;

    for (let scan = 0; scan < candidates.length; scan += 1) {
      const row = candidates[(cursor + scan) % candidates.length];
      if (used.has(String(row.post_id))) continue;

      const history = db
        .prepare(`SELECT 1 AS yes
          FROM comment_assistant_history
          WHERE account = ? AND post_id = ?
          LIMIT 1`)
        .get(account, String(row.post_id));
      if (history) continue;

      candidate = row;
      cursor += scan + 1;
      break;
    }

    if (!candidate) break;

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
        VALUES (?, ?, ?, 'CLAIMED', LOCALTIMESTAMP)`).run(taskId, worker, account);
      used.add(String(candidate.post_id));
      claimed.push({
        task_id: taskId,
        post_id: candidate.post_id,
        post_link: candidate.post_link,
        account
      });
    } catch (_) {
      used.add(String(candidate.post_id));
    }
  }

  touchWorker(worker, {
    account: accounts.join(','),
    status: claimed.length ? 'tasks-claimed' : 'idle',
    note: `${DEFAULT_TASK_NAME}：领取 ${claimed.length} 条`
  });

  if (claimed.length && accounts.length) {
    for (const account of accounts) {
      spawnLoopExecutionForAccount(worker, account, loops, intervalMinutes);
    }
  }

  return { worker, loops, accounts, count: claimed.length, items: claimed };
}

function claimSinglePublishedTask(taskId, worker, accounts) {
  const task = db
    .prepare(`SELECT task_id, post_id, post_link, post_text, note, priority
      FROM comment_assistant_tasks
      WHERE task_id = ? AND status = 'OPEN'`)
    .get(taskId);

  if (!task) throw new Error('任务不存在或已被领取');

  const account = accounts[0];
  db.prepare(`INSERT INTO comment_assistant_task_assignments
    (task_id, worker_id, account, status, claimed_at)
    VALUES (?, ?, ?, 'CLAIMED', LOCALTIMESTAMP)`).run(task.task_id, worker, account);
  db.prepare(`UPDATE comment_assistant_tasks
    SET status = 'CLAIMED', updated_at = LOCALTIMESTAMP
    WHERE task_id = ? AND status = 'OPEN'`).run(task.task_id);

  touchWorker(worker, {
    account,
    status: 'tasks-claimed',
    note: '领取 1 条管理员任务'
  });

  return { worker, loops: 1, accounts: [account], count: 1, items: [{ ...task, account }] };
}

app.get('/api/health', userAuth, (req, res) => {
  cleanupWorkers();
  const taskStats = db
    .prepare('SELECT status, COUNT(*) AS cnt FROM comment_assistant_tasks GROUP BY status')
    .all();
  res.json({
    success: true,
    data: {
      host: os.hostname(),
      now: new Date().toISOString(),
      accounts: listAccounts().length,
      workers: workers.size,
      tasks: taskStats
    }
  });
});

app.get('/api/accounts', userAuth, (req, res) => {
  res.json({ success: true, data: listAccounts() });
});

app.post('/api/accounts', userAuth, (req, res) => {
  try {
    res.json({ success: true, data: createAccount(req.body?.name) });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.delete('/api/accounts/:name', userAuth, (req, res) => {
  try {
    res.json({ success: true, data: deleteAccount(req.params.name) });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.post('/api/accounts/:name/login', userAuth, (req, res) => {
  try {
    res.json({ success: true, data: launchAccountLogin(req.params.name) });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.post('/api/heartbeat', userAuth, (req, res) => {
  const worker = touchWorker(req.body?.worker || DEFAULT_WORKER_ID, {
    account: req.body?.account,
    status: req.body?.status,
    note: req.body?.note
  });
  res.json({ success: true, data: worker });
});

app.get('/api/available-tasks', userAuth, (req, res) => {
  res.json({ success: true, data: availableTasks() });
});

app.get('/api/my-tasks', userAuth, (req, res) => {
  const worker = workerKey(req.query.worker || DEFAULT_WORKER_ID);
  const accountMap = new Map(listAccounts().map(item => [item.name, item]));
  const rows = db
    .prepare(`SELECT a.account, COUNT(*) AS assigned_count,
        SUM(CASE WHEN a.status = 'DONE' THEN 1 ELSE 0 END) AS completed_count,
        SUM(CASE WHEN a.status = 'CLAIMED' THEN 1 ELSE 0 END) AS running_count,
        SUM(CASE WHEN a.status = 'SKIPPED' THEN 1 ELSE 0 END) AS interrupted_count,
        SUM(CASE WHEN t.created_by = ? THEN 1 ELSE 0 END) AS default_task_count,
        MAX(a.claimed_at) AS last_claimed_at
      FROM comment_assistant_task_assignments a
      JOIN comment_assistant_tasks t ON t.task_id = a.task_id
      WHERE a.worker_id = ?
      GROUP BY a.account
      ORDER BY MAX(a.claimed_at) DESC`)
    .all(DEFAULT_TASK_ID, worker)
    .map(row => {
      const account = accountMap.get(row.account) || {};
      return {
        ...row,
        uid: account.uid || null,
        username: account.name || row.account,
        task_name: Number(row.default_task_count || 0) > 0 ? DEFAULT_TASK_NAME : '自定义任务',
        target_count: TASK_TARGET_PER_ACCOUNT,
        progress_count: Math.min(Number(row.completed_count || 0), TASK_TARGET_PER_ACCOUNT)
      };
    });
  res.json({ success: true, data: rows });
});

app.get('/api/execution-logs', userAuth, (req, res) => {
  const worker = workerKey(req.query.worker || DEFAULT_WORKER_ID);
  const account = sanitizeAccount(req.query.account || '');
  const limitValue = Number(req.query.limit || 200);
  const limit = Math.max(1, Math.min(Number.isFinite(limitValue) ? limitValue : 200, 500));
  const rows = account
    ? db.prepare(`SELECT log_id, worker_id, account, task_id, post_id, post_link,
        round_no, item_no, status, detail, created_at
      FROM comment_assistant_execution_logs
      WHERE worker_id = ? AND account = ?
      ORDER BY log_id DESC LIMIT ?`).all(worker, account, limit)
    : db.prepare(`SELECT log_id, worker_id, account, task_id, post_id, post_link,
        round_no, item_no, status, detail, created_at
      FROM comment_assistant_execution_logs
      WHERE worker_id = ?
      ORDER BY log_id DESC LIMIT ?`).all(worker, limit);
  res.json({ success: true, data: rows });
});

app.post('/api/my-tasks/:account/action', userAuth, (req, res) => {
  try {
    const worker = workerKey(req.body?.worker || DEFAULT_WORKER_ID);
    const account = sanitizeAccount(req.params.account);
    const action = String(req.body?.action || '').trim().toLowerCase();

    if (!account) return res.status(400).json({ success: false, message: 'account required' });
    if (!['interrupt', 'complete', 'delete'].includes(action)) {
      return res.status(400).json({ success: false, message: 'invalid action' });
    }

    const assignments = db
      .prepare(`SELECT task_id, status
        FROM comment_assistant_task_assignments
        WHERE worker_id = ? AND account = ?`)
      .all(worker, account);

    if (!assignments.length) {
      return res.status(404).json({ success: false, message: '没有找到该账号的任务' });
    }

    if (action === 'interrupt') {
      const activeIds = assignments.filter(x => x.status === 'CLAIMED').map(x => x.task_id);
      db.prepare(`UPDATE comment_assistant_task_assignments
        SET status = 'SKIPPED', result = '用户中断', completed_at = LOCALTIMESTAMP
        WHERE worker_id = ? AND account = ? AND status = 'CLAIMED'`).run(worker, account);
      for (const taskId of activeIds) {
        db.prepare(`UPDATE comment_assistant_tasks
          SET status = 'SKIPPED', updated_at = LOCALTIMESTAMP
          WHERE task_id = ? AND status = 'CLAIMED'`).run(taskId);
      }
    }

    if (action === 'complete') {
      const ids = assignments.map(x => x.task_id);
      db.prepare(`UPDATE comment_assistant_task_assignments
        SET status = 'DONE', result = '手动标记已完成', completed_at = LOCALTIMESTAMP
        WHERE worker_id = ? AND account = ?`).run(worker, account);
      for (const taskId of ids) {
        db.prepare(`UPDATE comment_assistant_tasks
          SET status = 'DONE', updated_at = LOCALTIMESTAMP
          WHERE task_id = ?`).run(taskId);
      }
    }

    if (action === 'delete') {
      const ids = assignments.map(x => x.task_id);
      for (const taskId of ids) {
        db.prepare(`UPDATE comment_assistant_tasks
          SET status = 'OPEN', updated_at = LOCALTIMESTAMP
          WHERE task_id = ? AND status IN ('CLAIMED', 'SKIPPED')`).run(taskId);
      }
      db.prepare(`DELETE FROM comment_assistant_task_assignments
        WHERE worker_id = ? AND account = ?`).run(worker, account);
    }

    res.json({ success: true, data: { account, action } });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.post('/api/tasks/:taskId/claim', userAuth, (req, res) => {
  try {
    const taskId = String(req.params.taskId || '').trim();
    const worker = workerKey(req.body?.worker || DEFAULT_WORKER_ID);
    const accounts = Array.isArray(req.body?.accounts)
      ? req.body.accounts.map(sanitizeAccount).filter(Boolean)
      : [];
    const loops = Math.max(1, Math.min(Number(req.body?.loops || 1), 20));
    const intervalMinutes = Math.max(0, Math.min(Number(req.body?.interval_minutes || 0), 1440));

    if (!accounts.length) {
      return res.status(400).json({ success: false, message: '至少选择一个账号' });
    }

    const data = taskId === DEFAULT_TASK_ID
      ? claimBuiltinRandomHighExp(worker, accounts, loops, intervalMinutes)
      : claimSinglePublishedTask(taskId, worker, accounts);

    res.json({ success: true, data });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.post('/api/tasks/claim', userAuth, (req, res) => {
  const worker = workerKey(req.body?.worker || DEFAULT_WORKER_ID);
  const accounts = Array.isArray(req.body?.accounts)
    ? req.body.accounts.map(sanitizeAccount).filter(Boolean)
    : [];
  const loops = Math.max(1, Math.min(Number(req.body?.loops || 1), 20));
  const intervalMinutes = Math.max(0, Math.min(Number(req.body?.interval_minutes || 0), 1440));

  if (!accounts.length) {
    return res.status(400).json({ success: false, message: '至少选择一个账号' });
  }

  res.json({ success: true, data: claimBuiltinRandomHighExp(worker, accounts, loops, intervalMinutes) });
});

app.post('/api/tasks/:taskId/result', userAuth, (req, res) => {
  const taskId = String(req.params.taskId || '').trim();
  const worker = workerKey(req.body?.worker || DEFAULT_WORKER_ID);
  const status = normalizeStatus(req.body?.status);
  const result = String(req.body?.result || '').trim().slice(0, 1000);

  if (!taskId) return res.status(400).json({ success: false, message: 'taskId required' });
  if (!['DONE', 'SKIPPED'].includes(status)) {
    return res.status(400).json({ success: false, message: 'status must be DONE or SKIPPED' });
  }

  const assignment = db
    .prepare(`SELECT task_id, account
      FROM comment_assistant_task_assignments
      WHERE task_id = ? AND worker_id = ?`)
    .get(taskId, worker);

  if (!assignment) {
    return res.status(404).json({ success: false, message: '任务不属于当前 Worker' });
  }

  db.prepare(`UPDATE comment_assistant_task_assignments
    SET status = ?, result = ?, completed_at = LOCALTIMESTAMP
    WHERE task_id = ? AND worker_id = ?`).run(status, result, taskId, worker);
  db.prepare(`UPDATE comment_assistant_tasks
    SET status = ?, updated_at = LOCALTIMESTAMP
    WHERE task_id = ?`).run(status, taskId);

  res.json({ success: true });
});

app.get('/api/admin/tasks', adminAuth, (req, res) => {
  const status = normalizeStatus(req.query.status);
  const sql = `SELECT t.*, a.worker_id, a.account, a.claimed_at, a.completed_at, a.result
    FROM comment_assistant_tasks t
    LEFT JOIN comment_assistant_task_assignments a ON a.task_id = t.task_id`;
  const rows = status
    ? db.prepare(`${sql} WHERE t.status = ? ORDER BY t.priority DESC, t.created_at DESC LIMIT 500`).all(status)
    : db.prepare(`${sql} ORDER BY t.priority DESC, t.created_at DESC LIMIT 500`).all();
  res.json({ success: true, data: rows });
});

app.post('/api/admin/tasks', adminAuth, (req, res) => {
  const postLink = String(req.body?.post_link || '').trim();
  const postId = String(req.body?.post_id || '').trim();
  const postText = String(req.body?.post_text || '').trim().slice(0, 4000);
  const note = String(req.body?.note || '').trim().slice(0, 1000);
  const rawPriority = Number(req.body?.priority || 0);
  const priority = Number.isFinite(rawPriority) ? Math.max(-999, Math.min(rawPriority, 999)) : 0;

  if (!postLink) return res.status(400).json({ success: false, message: 'post_link required' });

  const taskId = makeTaskId();
  db.prepare(`INSERT INTO comment_assistant_tasks
    (task_id, post_id, post_link, post_text, note, priority, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, 'OPEN', 'admin')`).run(
    taskId,
    postId || null,
    postLink,
    postText || null,
    note || null,
    priority
  );
  res.json({ success: true, data: { task_id: taskId } });
});

app.post('/api/admin/tasks/:taskId/cancel', adminAuth, (req, res) => {
  const taskId = String(req.params.taskId || '').trim();
  db.prepare(`UPDATE comment_assistant_tasks
    SET status = 'CANCELLED', updated_at = LOCALTIMESTAMP
    WHERE task_id = ?`).run(taskId);
  res.json({ success: true });
});

app.get('/api/admin/workers', adminAuth, (req, res) => {
  cleanupWorkers();
  const data = Array.from(workers.values())
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .map(item => ({ ...item, lastSeenAt: new Date(item.lastSeenAt).toISOString() }));
  res.json({ success: true, data });
});

app.get('/', (req, res) => res.redirect('/user'));
app.get('/user', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'user.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

app.listen(PORT, HOST, () => {
  console.log(`[Comment Assistant] http://${HOST}:${PORT}/user`);
  console.log(`[Comment Assistant] Admin: http://${HOST}:${PORT}/admin`);
  console.log(`[Comment Assistant] Profiles=${PROFILE_ROOT}`);
  console.log(`[Comment Assistant] Worker=${DEFAULT_WORKER_ID}`);
  console.log(`[Comment Assistant] Admin=${ADMIN_TOKEN ? 'enabled' : 'disabled (set COMMENT_ADMIN_TOKEN)'}`);
});