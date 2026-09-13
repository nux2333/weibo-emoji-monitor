'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { db, initDatabase } = require('../../src/db');

const ROOT = path.join(__dirname, '..', '..');
const PROFILE_ROOT = path.join(ROOT, 'data', 'comment-assistant-profiles');
const LEGACY_PROFILE_DIR = path.join(ROOT, 'data', 'comment-assistant-profile');
const HOST = String(process.env.COMMENT_WORKER_API_HOST || '127.0.0.1');
const PORT = Number(process.env.COMMENT_WORKER_API_PORT || 3012);
const TOKEN = String(process.env.COMMENT_API_TOKEN || '').trim();
const ADMIN_TOKEN = String(process.env.COMMENT_ADMIN_TOKEN || '').trim();
const WORKER_TTL_MS = Math.max(30_000, Number(process.env.COMMENT_WORKER_TTL_MS || 2 * 60_000));
const DEFAULT_TASK_ID = 'builtin-random-high-exp';
const DEFAULT_TASK_NAME = '随机高经验值用户轮询';

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

const app = express();
app.use(express.json({ limit: '128kb' }));
const workers = new Map();

function sanitizeAccount(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return safe || null;
}

function accountProfileDir(account) {
  return account === 'default'
    ? LEGACY_PROFILE_DIR
    : path.join(PROFILE_ROOT, account);
}

function hasProfileData(profileDir) {
  if (!fs.existsSync(profileDir)) return false;
  return [
    path.join(profileDir, 'Default', 'Network', 'Cookies'),
    path.join(profileDir, 'Default', 'Cookies'),
    path.join(profileDir, 'Local State')
  ].some(file => fs.existsSync(file));
}

function listAccounts() {
  const result = [];
  if (fs.existsSync(LEGACY_PROFILE_DIR)) {
    result.push({ name: 'default', username: null, legacy: true, initialized: hasProfileData(LEGACY_PROFILE_DIR) });
  }
  try {
    const names = fs.readdirSync(PROFILE_ROOT, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' }));
    for (const name of names) {
      result.push({ name, username: null, legacy: false, initialized: hasProfileData(path.join(PROFILE_ROOT, name)) });
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
  return { name: safe, username: null, legacy: false, initialized: false };
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
  if (bearer(req) !== TOKEN) return res.status(401).json({ success: false, message: 'unauthorized' });
  next();
}

function adminAuth(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ success: false, message: 'COMMENT_ADMIN_TOKEN 未设置，管理员功能未启用' });
  if (bearer(req) !== ADMIN_TOKEN) return res.status(401).json({ success: false, message: 'admin unauthorized' });
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
  const v = String(value || '').toUpperCase();
  return ['OPEN', 'CLAIMED', 'DONE', 'SKIPPED', 'CANCELLED'].includes(v) ? v : null;
}

function availableTasks() {
  const rows = db.prepare(`SELECT task_id, post_id, post_link, post_text, note, priority, created_at
    FROM comment_assistant_tasks
    WHERE status = 'OPEN' AND COALESCE(created_by, '') <> ?
    ORDER BY priority DESC, created_at ASC
    LIMIT 200`).all(DEFAULT_TASK_ID);
  return [
    {
      task_id: DEFAULT_TASK_ID,
      kind: 'builtin',
      name: DEFAULT_TASK_NAME,
      note: '按已选账号和 Loop 回数生成随机高经验值帖子待处理队列；实际帖子仍由用户打开后处理。',
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

function claimBuiltinRandomHighExp(worker, accounts, loops) {
  const targetCount = Math.min(accounts.length * loops, 200);
  const poolSize = Math.max(targetCount * 8, 80);
  const candidates = db.prepare(`SELECT sp.post_id, sp.uid, sp.username, sp.post_link, sp.post_text,
      sp.experience_7d, sp.comments_count
    FROM superlike_posts sp
    WHERE COALESCE(sp.current_has_superlike, 0) = 0
      AND sp.experience_7d IS NOT NULL
      AND sp.experience_7d >= 70
      AND COALESCE(sp.comments_count, 0) <= 19
      AND sp.post_link IS NOT NULL
      AND CAST(sp.post_created_at AS date) = CAST(LOCALTIMESTAMP AS date)
      AND NOT EXISTS (SELECT 1 FROM black_fan_users b WHERE CAST(b.uid AS TEXT) = CAST(sp.uid AS TEXT))
    ORDER BY RANDOM()
    LIMIT ?`).all(poolSize);

  const claimed = [];
  const usedByAccount = new Map();
  for (let i = 0; i < accounts.length; i += 1) usedByAccount.set(accounts[i], new Set());

  let cursor = 0;
  while (claimed.length < targetCount && cursor < candidates.length * Math.max(1, accounts.length)) {
    const account = accounts[claimed.length % accounts.length];
    const used = usedByAccount.get(account);
    let candidate = null;
    for (let scan = 0; scan < candidates.length; scan += 1) {
      const row = candidates[(cursor + scan) % candidates.length];
      if (used.has(String(row.post_id))) continue;
      const history = db.prepare(`SELECT 1 AS yes FROM comment_assistant_history
        WHERE account = ? AND post_id = ? LIMIT 1`).get(account, String(row.post_id));
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
      claimed.push({ task_id: taskId, post_id: candidate.post_id, post_link: candidate.post_link, account });
    } catch (_) {
      used.add(String(candidate.post_id));
    }
  }

  touchWorker(worker, {
    account: accounts.join(','),
    status: claimed.length ? 'tasks-claimed' : 'idle',
    note: `${DEFAULT_TASK_NAME}：领取 ${claimed.length} 条`
  });
  return { worker, loops, accounts, count: claimed.length, items: claimed };
}

function claimSinglePublishedTask(taskId, worker, accounts) {
  const task = db.prepare(`SELECT task_id, post_id, post_link, post_text, note, priority
    FROM comment_assistant_tasks WHERE task_id = ? AND status = 'OPEN'`).get(taskId);
  if (!task) throw new Error('任务不存在或已被领取');
  const account = accounts[0];
  db.prepare(`INSERT INTO comment_assistant_task_assignments
    (task_id, worker_id, account, status, claimed_at)
    VALUES (?, ?, ?, 'CLAIMED', LOCALTIMESTAMP)`).run(task.task_id, worker, account);
  db.prepare(`UPDATE comment_assistant_tasks SET status = 'CLAIMED', updated_at = LOCALTIMESTAMP
    WHERE task_id = ? AND status = 'OPEN'`).run(task.task_id);
  touchWorker(worker, { account, status: 'tasks-claimed', note: '领取 1 条管理员任务' });
  return { worker, loops: 1, accounts: [account], count: 1, items: [{ ...task, account }] };
}

app.get('/api/health', userAuth, (req, res) => {
  cleanupWorkers();
  const taskStats = db.prepare('SELECT status, COUNT(*) AS cnt FROM comment_assistant_tasks GROUP BY status').all();
  res.json({ success: true, data: {
    host: os.hostname(),
    now: new Date().toISOString(),
    accounts: listAccounts().length,
    workers: workers.size,
    tasks: taskStats
  }});
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

app.post('/api/accounts/:name/login', userAuth, (req, res) => {
  try {
    const data = launchAccountLogin(req.params.name);
    res.json({ success: true, data });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.post('/api/heartbeat', userAuth, (req, res) => {
  const worker = touchWorker(req.body?.worker, {
    account: req.body?.account,
    status: req.body?.status,
    note: req.body?.note
  });
  if (!worker) return res.status(400).json({ success: false, message: 'worker required' });
  res.json({ success: true, data: worker });
});

app.get('/api/available-tasks', userAuth, (req, res) => {
  res.json({ success: true, data: availableTasks() });
});

app.get('/api/my-tasks', userAuth, (req, res) => {
  const worker = workerKey(req.query.worker);
  if (!worker) return res.status(400).json({ success: false, message: 'worker required' });
  const rows = db.prepare(`SELECT t.task_id, t.post_id, t.post_link, t.post_text, t.note, t.priority,
      t.status, a.account, a.status AS assignment_status, a.claimed_at, a.completed_at, a.result
    FROM comment_assistant_task_assignments a
    JOIN comment_assistant_tasks t ON t.task_id = a.task_id
    WHERE a.worker_id = ?
    ORDER BY a.claimed_at DESC`).all(worker);
  res.json({ success: true, data: rows });
});

app.post('/api/tasks/:taskId/claim', userAuth, (req, res) => {
  try {
    const taskId = String(req.params.taskId || '').trim();
    const worker = workerKey(req.body?.worker);
    const accounts = Array.isArray(req.body?.accounts) ? req.body.accounts.map(sanitizeAccount).filter(Boolean) : [];
    const loops = Math.max(1, Math.min(Number(req.body?.loops || 1), 20));
    if (!worker) return res.status(400).json({ success: false, message: 'worker required' });
    if (!accounts.length) return res.status(400).json({ success: false, message: '至少选择一个账号' });

    const data = taskId === DEFAULT_TASK_ID
      ? claimBuiltinRandomHighExp(worker, accounts, loops)
      : claimSinglePublishedTask(taskId, worker, accounts);
    res.json({ success: true, data });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.post('/api/tasks/claim', userAuth, (req, res) => {
  const worker = workerKey(req.body?.worker);
  const accounts = Array.isArray(req.body?.accounts) ? req.body.accounts.map(sanitizeAccount).filter(Boolean) : [];
  const loops = Math.max(1, Math.min(Number(req.body?.loops || 1), 20));
  if (!worker) return res.status(400).json({ success: false, message: 'worker required' });
  if (!accounts.length) return res.status(400).json({ success: false, message: '至少选择一个账号' });
  res.json({ success: true, data: claimBuiltinRandomHighExp(worker, accounts, loops) });
});

app.post('/api/tasks/:taskId/result', userAuth, (req, res) => {
  const taskId = String(req.params.taskId || '').trim();
  const worker = workerKey(req.body?.worker);
  const status = normalizeStatus(req.body?.status);
  const result = String(req.body?.result || '').trim().slice(0, 1000);
  if (!worker || !taskId) return res.status(400).json({ success: false, message: 'worker/taskId required' });
  if (!['DONE', 'SKIPPED'].includes(status)) return res.status(400).json({ success: false, message: 'status must be DONE or SKIPPED' });

  const assignment = db.prepare(`SELECT task_id, account FROM comment_assistant_task_assignments
    WHERE task_id = ? AND worker_id = ?`).get(taskId, worker);
  if (!assignment) return res.status(404).json({ success: false, message: '任务不属于当前 Worker' });

  db.prepare(`UPDATE comment_assistant_task_assignments
    SET status = ?, result = ?, completed_at = LOCALTIMESTAMP
    WHERE task_id = ? AND worker_id = ?`).run(status, result, taskId, worker);
  db.prepare(`UPDATE comment_assistant_tasks SET status = ?, updated_at = LOCALTIMESTAMP
    WHERE task_id = ?`).run(status, taskId);
  res.json({ success: true });
});

app.get('/api/admin/tasks', adminAuth, (req, res) => {
  const status = normalizeStatus(req.query.status);
  const rows = status
    ? db.prepare(`SELECT t.*, a.worker_id, a.account, a.claimed_at, a.completed_at, a.result
        FROM comment_assistant_tasks t
        LEFT JOIN comment_assistant_task_assignments a ON a.task_id = t.task_id
        WHERE t.status = ? ORDER BY t.priority DESC, t.created_at DESC LIMIT 500`).all(status)
    : db.prepare(`SELECT t.*, a.worker_id, a.account, a.claimed_at, a.completed_at, a.result
        FROM comment_assistant_tasks t
        LEFT JOIN comment_assistant_task_assignments a ON a.task_id = t.task_id
        ORDER BY t.created_at DESC LIMIT 500`).all();
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
    VALUES (?, ?, ?, ?, ?, ?, 'OPEN', 'admin')`).run(taskId, postId || null, postLink, postText || null, note || null, priority);
  res.json({ success: true, data: { task_id: taskId } });
});

app.post('/api/admin/tasks/:taskId/cancel', adminAuth, (req, res) => {
  const taskId = String(req.params.taskId || '').trim();
  db.prepare("UPDATE comment_assistant_tasks SET status = 'CANCELLED', updated_at = LOCALTIMESTAMP WHERE task_id = ?").run(taskId);
  res.json({ success: true });
});

app.get('/api/admin/workers', adminAuth, (req, res) => {
  cleanupWorkers();
  const data = Array.from(workers.values())
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .map(x => ({ ...x, lastSeenAt: new Date(x.lastSeenAt).toISOString() }));
  res.json({ success: true, data });
});

const baseCss = `
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:#f5f6f8;color:#222}.wrap{max-width:1180px;margin:18px auto;padding:0 14px}.card{background:#fff;border-radius:14px;padding:16px;margin-bottom:14px;box-shadow:0 2px 12px rgba(0,0,0,.06)}h1,h2,h3{margin:0 0 12px}.top{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}.row{display:flex;gap:10px;align-items:end;flex-wrap:wrap}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}.box{border:1px solid #e8e8e8;border-radius:10px;padding:10px}input,select,button,textarea{font:inherit;padding:9px 10px;border-radius:8px}input,select,textarea{border:1px solid #ccc;background:#fff}button{border:0;background:#111;color:#fff;cursor:pointer}.blue{background:#1677ff}.green{background:#15803d}.gray{background:#6b7280}.red{background:#b91c1c}.muted{font-size:13px;color:#666}.ok{color:#15803d}.warn{color:#b45309}.bad{color:#b91c1c}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:8px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}th{background:#fafafa;font-weight:600}.account-table th:first-child,.account-table td:first-child{width:42px;text-align:center}.account-table th:nth-child(2),.account-table td:nth-child(2){width:54px;text-align:center}.account-table tbody tr:hover,.task-catalog tbody tr:hover{background:#fafafa}.account-table input[type=checkbox]{width:16px;height:16px;min-width:0;margin:0}.scroll{overflow:auto;max-height:58vh}a{color:#1677ff;text-decoration:none}.log{background:#111;color:#ddd;border-radius:10px;padding:10px;min-height:130px;max-height:260px;overflow:auto;font-family:Consolas,monospace;font-size:12px;white-space:pre-wrap}.pill{display:inline-block;border-radius:999px;padding:2px 8px;background:#eef2ff;font-size:12px}.fatal{background:#fee2e2;color:#991b1b;border:1px solid #fecaca;border-radius:10px;padding:10px;margin-bottom:12px;display:none}.login-ok{color:#15803d;font-weight:600}.login-relogin{color:#9ca3af;font-weight:600}.collapse-toggle{background:transparent;color:#444;border:1px solid #ddd;padding:5px 10px}.collapse-toggle:hover{background:#f3f4f6}.account-panel.collapsed,.collapsible-panel.collapsed{display:none}.account-scroll{max-height:320px;overflow:auto}.relogin-btn{margin-left:10px;padding:4px 8px;background:#f3f4f6;color:#374151;border:1px solid #d1d5db;font-size:12px}.relogin-btn:hover{background:#e5e7eb}.task-claim{padding:5px 10px;background:#15803d}.section-gap{margin-top:18px}.builtin-task td{background:#f8fff9}
`;

const clientCommon = String.raw`
function byId(id){return document.getElementById(id)}
function esc(v){return String(v == null ? '' : v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function showFatal(message){var el=byId('fatal');if(!el)return;el.style.display='block';el.textContent='页面脚本错误：'+message}
window.addEventListener('error',function(e){showFatal(e.message || 'unknown error')});
window.addEventListener('unhandledrejection',function(e){showFatal((e.reason && e.reason.message) || String(e.reason || 'Promise error'))});
`;

function userPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Comment Assistant 用户端</title><style>${baseCss}</style></head><body><div class="wrap">
<div id="fatal" class="fatal"></div>
<div class="card"><div class="top"><div><h1>Comment Assistant 用户端</h1><div class="muted">账号管理、任务领取、处理记录</div></div><a href="/admin">管理员画面 →</a></div></div>
<div class="card"><div class="row"><div><div class="muted">API Token</div><input id="token" type="password"></div><div><div class="muted">本机名称</div><input id="worker" placeholder="例如 PC-A"></div><button id="connect">连接</button><button class="blue" id="add">＋ 添加微博账号</button></div><div id="health" class="muted" style="margin-top:10px">未连接</div></div>
<div class="card"><div class="top"><div style="display:flex;gap:8px;align-items:center"><h2 style="margin:0">当前可执行账号</h2><span id="accountCount" class="pill">0</span></div><button id="toggleAccounts" class="collapse-toggle" type="button">收起 ▲</button></div><div id="accountPanel" class="account-panel"><div class="account-scroll"><table class="account-table"><thead><tr><th><input id="selectAllAccounts" type="checkbox" title="全选"></th><th>No</th><th>用户ID</th><th>用户名</th><th>登录状态</th></tr></thead><tbody id="accounts"><tr><td colspan="5" class="muted">请先连接</td></tr></tbody></table></div><div class="row" style="margin-top:12px"><div><div class="muted">Loop 回数</div><input id="loops" type="number" min="1" max="20" value="1" style="width:80px"></div><div class="muted">先选账号和 Loop，再到下面任务列表中点击对应任务后的“领取任务”。</div></div></div></div>
<div class="card"><div class="top"><h2 style="margin:0">任务列表 / 执行结果</h2><button id="toggleTasks" class="collapse-toggle" type="button">收起 ▲</button></div><div id="tasksPanel" class="collapsible-panel"><h3>可领取任务</h3><div class="scroll"><table class="task-catalog"><thead><tr><th>任务</th><th>说明</th><th>操作</th></tr></thead><tbody id="availableTasks"><tr><td colspan="3" class="muted">请先连接</td></tr></tbody></table></div><h3 class="section-gap">我的任务</h3><div class="scroll"><table><thead><tr><th>账号</th><th>状态</th><th>帖子</th><th>备注</th><th>操作</th></tr></thead><tbody id="tasks"></tbody></table></div></div></div>
<div class="card"><div class="top"><h2 style="margin:0">执行 Log</h2><button id="toggleLog" class="collapse-toggle" type="button">收起 ▲</button></div><div id="logPanel" class="collapsible-panel"><div id="log" class="log"></div></div></div>
</div><script>${clientCommon}
(function(){
  var tokenEl=byId('token');
  var workerEl=byId('worker');
  tokenEl.value=sessionStorage.getItem('caToken')||'';
  workerEl.value=localStorage.getItem('caWorker')||('PC-'+Math.random().toString(36).slice(2,6));

  function log(message){var el=byId('log');el.textContent+='['+new Date().toLocaleTimeString()+'] '+message+'\\n';el.scrollTop=el.scrollHeight}
  async function api(url,opt){opt=opt||{};var r=await fetch(url,Object.assign({},opt,{headers:Object.assign({'Content-Type':'application/json','Authorization':'Bearer '+tokenEl.value.trim()},opt.headers||{})}));var j;try{j=await r.json()}catch(_){j={success:false,message:'HTTP '+r.status}}if(!r.ok||!j.success)throw new Error(j.message||('HTTP '+r.status));return j.data}
  function initCollapse(buttonId,panelId,storageKey){var button=byId(buttonId);var panel=byId(panelId);function apply(collapsed){panel.classList.toggle('collapsed',collapsed);button.textContent=collapsed?'展开 ▼':'收起 ▲'}var initial=localStorage.getItem(storageKey)==='1';apply(initial);button.addEventListener('click',function(){var collapsed=!panel.classList.contains('collapsed');apply(collapsed);localStorage.setItem(storageKey,collapsed?'1':'0')})}
  function selectedAccounts(){return Array.prototype.map.call(document.querySelectorAll('.acct:checked'),function(x){return x.value})}

  async function loadAccounts(){var list=await api('/api/accounts');byId('accountCount').textContent=String(list.length);var body=byId('accounts');body.innerHTML='';byId('selectAllAccounts').checked=false;if(!list.length){body.innerHTML='<tr><td colspan="5" class="muted">暂无账号</td></tr>';return}list.forEach(function(item,index){var tr=document.createElement('tr');var checkTd=document.createElement('td');var checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.className='acct';checkbox.value=item.name;checkTd.appendChild(checkbox);var noTd=document.createElement('td');noTd.textContent=String(index+1);var idTd=document.createElement('td');idTd.textContent=item.name;var usernameTd=document.createElement('td');usernameTd.textContent=item.username||'-';var loginTd=document.createElement('td');var login=document.createElement('span');login.className=item.initialized?'login-ok':'login-relogin';login.textContent=item.initialized?'● 已登录':'● 需重新登录';loginTd.appendChild(login);var relogin=document.createElement('button');relogin.type='button';relogin.className='relogin-btn relogin-account';relogin.dataset.account=item.name;relogin.textContent='再次登录';loginTd.appendChild(relogin);tr.appendChild(checkTd);tr.appendChild(noTd);tr.appendChild(idTd);tr.appendChild(usernameTd);tr.appendChild(loginTd);body.appendChild(tr)})}

  async function loadAvailableTasks(){var list=await api('/api/available-tasks');var body=byId('availableTasks');body.innerHTML='';if(!list.length){body.innerHTML='<tr><td colspan="3" class="muted">暂无可领取任务</td></tr>';return}list.forEach(function(item){var tr=document.createElement('tr');if(item.kind==='builtin')tr.className='builtin-task';var name=document.createElement('td');name.textContent=item.name||item.task_id;var note=document.createElement('td');note.textContent=item.note||'-';var action=document.createElement('td');var button=document.createElement('button');button.className='task-claim claim-task';button.type='button';button.dataset.taskId=item.task_id;button.textContent='领取任务';action.appendChild(button);tr.appendChild(name);tr.appendChild(note);tr.appendChild(action);body.appendChild(tr)})}

  function resultButton(taskId,status,text,className){var button=document.createElement('button');button.className=className;button.textContent=text;button.dataset.taskId=taskId;button.dataset.status=status;button.classList.add('task-result');return button}
  async function loadTasks(){var worker=workerEl.value.trim();if(!worker)return;var list=await api('/api/my-tasks?worker='+encodeURIComponent(worker));var body=byId('tasks');body.innerHTML='';if(!list.length){body.innerHTML='<tr><td colspan="5" class="muted">暂无任务</td></tr>';return}list.forEach(function(item){var tr=document.createElement('tr');var c1=document.createElement('td');c1.textContent=item.account||'-';var c2=document.createElement('td');c2.textContent=item.assignment_status||item.status||'-';var c3=document.createElement('td');var a=document.createElement('a');a.target='_blank';a.rel='noopener';a.href=item.post_link;a.textContent='打开帖子';c3.appendChild(a);if(item.post_text){c3.appendChild(document.createElement('br'));var s=document.createElement('span');s.className='muted';s.textContent=item.post_text;c3.appendChild(s)}var c4=document.createElement('td');c4.textContent=item.note||'';var c5=document.createElement('td');if(item.assignment_status==='CLAIMED'){c5.appendChild(resultButton(item.task_id,'DONE','完成','green'));c5.appendChild(document.createTextNode(' '));c5.appendChild(resultButton(item.task_id,'SKIPPED','跳过','gray'))}else{c5.textContent='-'}[c1,c2,c3,c4,c5].forEach(function(td){tr.appendChild(td)});body.appendChild(tr)})}

  async function heartbeat(){try{await api('/api/heartbeat',{method:'POST',body:JSON.stringify({worker:workerEl.value.trim(),status:'online'})})}catch(_){}}
  async function connect(){sessionStorage.setItem('caToken',tokenEl.value.trim());localStorage.setItem('caWorker',workerEl.value.trim());try{var h=await api('/api/health');byId('health').innerHTML='<span class="ok">● 已连接</span> | Host='+esc(h.host)+' | Accounts='+h.accounts+' | Workers='+h.workers;await loadAccounts();await loadAvailableTasks();await loadTasks();await heartbeat();log('连接成功')}catch(e){byId('health').innerHTML='<span class="bad">'+esc(e.message)+'</span>';log('连接失败：'+e.message)}}

  byId('connect').addEventListener('click',connect);
  byId('add').addEventListener('click',async function(){var name=prompt('新微博账号名称');if(!name)return;try{var account=await api('/api/accounts',{method:'POST',body:JSON.stringify({name:name})});log('已创建账号目录：'+account.name);await loadAccounts();alert('账号目录已创建。可以直接点击该账号后的“再次登录”打开 Chromium 扫码登录。')}catch(e){alert(e.message)}});
  byId('selectAllAccounts').addEventListener('change',function(){var checked=this.checked;document.querySelectorAll('.acct').forEach(function(x){x.checked=checked})});
  byId('accounts').addEventListener('change',function(){var all=document.querySelectorAll('.acct');var selected=document.querySelectorAll('.acct:checked');byId('selectAllAccounts').checked=all.length>0&&all.length===selected.length});
  byId('accounts').addEventListener('click',async function(e){var button=e.target.closest('.relogin-account');if(!button)return;button.disabled=true;var oldText=button.textContent;button.textContent='正在打开...';try{var data=await api('/api/accounts/'+encodeURIComponent(button.dataset.account)+'/login',{method:'POST',body:'{}'});log('已打开 '+data.account+' 的 Chromium 登录窗口');setTimeout(function(){loadAccounts().catch(function(){})},3000)}catch(err){alert(err.message);log('打开登录窗口失败：'+err.message)}finally{button.disabled=false;button.textContent=oldText}});
  byId('availableTasks').addEventListener('click',async function(e){var button=e.target.closest('.claim-task');if(!button)return;var accounts=selectedAccounts();var loops=Number(byId('loops').value||1);if(!accounts.length){alert('请先在“当前可执行账号”里选择至少一个账号');return}button.disabled=true;var old=button.textContent;button.textContent='领取中...';try{var data=await api('/api/tasks/'+encodeURIComponent(button.dataset.taskId)+'/claim',{method:'POST',body:JSON.stringify({worker:workerEl.value.trim(),accounts:accounts,loops:loops})});log('任务 '+button.dataset.taskId+' 领取 '+data.count+' 条 | 账号='+accounts.join(',')+' | Loop='+loops);await loadAvailableTasks();await loadTasks()}catch(err){alert(err.message);log('领取任务失败：'+err.message)}finally{button.disabled=false;button.textContent=old}});
  byId('tasks').addEventListener('click',async function(e){var button=e.target.closest('.task-result');if(!button)return;try{await api('/api/tasks/'+encodeURIComponent(button.dataset.taskId)+'/result',{method:'POST',body:JSON.stringify({worker:workerEl.value.trim(),status:button.dataset.status})});log('任务 '+button.dataset.taskId+' → '+button.dataset.status);await loadTasks()}catch(err){alert(err.message)}});
  initCollapse('toggleAccounts','accountPanel','caAccountsCollapsed');
  initCollapse('toggleTasks','tasksPanel','caTasksCollapsed');
  initCollapse('toggleLog','logPanel','caLogCollapsed');
  if(tokenEl.value)connect();
  setInterval(function(){if(tokenEl.value){heartbeat();loadAvailableTasks().catch(function(){});loadTasks().catch(function(){})}},15000);
})();
</script></body></html>`;
}

function adminPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Comment Assistant 管理员</title><style>${baseCss}</style></head><body><div class="wrap">
<div id="fatal" class="fatal"></div>
<div class="card"><div class="top"><div><h1>Comment Assistant 管理员</h1><div class="muted">发布任务、查看领取与完成状态</div></div><a href="/user">← 用户画面</a></div></div>
<div class="card"><div class="row"><div><div class="muted">Admin Token</div><input id="token" type="password"></div><button id="connect">连接</button></div><div id="state" class="muted" style="margin-top:8px">未连接</div></div>
<div class="card"><h2>发布任务</h2><div class="row"><input id="postId" placeholder="Post ID（可选）"><input id="link" placeholder="帖子链接" style="min-width:320px"><input id="priority" type="number" value="0" placeholder="优先级" style="width:90px"></div><div class="row" style="margin-top:8px"><textarea id="text" placeholder="帖子文案/说明（可选）" rows="2" style="min-width:320px"></textarea><textarea id="note" placeholder="任务备注（可选）" rows="2" style="min-width:260px"></textarea><button class="blue" id="publish">发布任务</button></div></div>
<div class="card"><div class="top"><h2>任务列表</h2><div><select id="status"><option value="">全部</option><option>OPEN</option><option>CLAIMED</option><option>DONE</option><option>SKIPPED</option><option>CANCELLED</option></select> <button id="refresh">刷新</button></div></div><div class="scroll"><table><thead><tr><th>状态</th><th>优先级</th><th>帖子</th><th>领取人</th><th>账号</th><th>结果</th><th>操作</th></tr></thead><tbody id="tasks"></tbody></table></div></div>
<div class="card"><h2>在线 Worker</h2><div id="workers" class="grid"></div></div>
</div><script>${clientCommon}
(function(){
  var tokenEl=byId('token');
  tokenEl.value=sessionStorage.getItem('caAdminToken')||'';
  async function api(url,opt){opt=opt||{};var r=await fetch(url,Object.assign({},opt,{headers:Object.assign({'Content-Type':'application/json','Authorization':'Bearer '+tokenEl.value.trim()},opt.headers||{})}));var j;try{j=await r.json()}catch(_){j={success:false,message:'HTTP '+r.status}}if(!r.ok||!j.success)throw new Error(j.message||('HTTP '+r.status));return j.data}
  async function load(){var status=byId('status').value;var q=status?'?status='+encodeURIComponent(status):'';var list=await api('/api/admin/tasks'+q);var body=byId('tasks');body.innerHTML='';if(!list.length){body.innerHTML='<tr><td colspan="7" class="muted">暂无任务</td></tr>'}else{list.forEach(function(item){var tr=document.createElement('tr');var values=[item.status,item.priority];values.forEach(function(v){var td=document.createElement('td');td.textContent=v==null?'-':String(v);tr.appendChild(td)});var post=document.createElement('td');var a=document.createElement('a');a.target='_blank';a.rel='noopener';a.href=item.post_link;a.textContent='打开';post.appendChild(a);if(item.post_text){post.appendChild(document.createElement('br'));var s=document.createElement('span');s.className='muted';s.textContent=item.post_text;post.appendChild(s)}tr.appendChild(post);var worker=document.createElement('td');worker.textContent=item.worker_id||'-';tr.appendChild(worker);var account=document.createElement('td');account.textContent=item.account||'-';tr.appendChild(account);var result=document.createElement('td');result.textContent=item.result||'-';tr.appendChild(result);var action=document.createElement('td');if(item.status!=='CANCELLED'&&item.status!=='DONE'){var cancel=document.createElement('button');cancel.className='red cancel-task';cancel.textContent='取消';cancel.dataset.taskId=item.task_id;action.appendChild(cancel)}else{action.textContent='-'}tr.appendChild(action);body.appendChild(tr)})}var ws=await api('/api/admin/workers');var workers=byId('workers');workers.innerHTML='';if(!ws.length){workers.innerHTML='<div class="muted">暂无在线 Worker</div>'}else{ws.forEach(function(item){var box=document.createElement('div');box.className='box';box.innerHTML='<b>'+esc(item.worker)+'</b><br>账号：'+esc(item.account||'-')+'<br>状态：'+esc(item.status||'-')+'<br><span class="muted">'+esc(item.lastSeenAt)+'</span>';workers.appendChild(box)})}}
  async function connect(){sessionStorage.setItem('caAdminToken',tokenEl.value.trim());try{await load();byId('state').innerHTML='<span class="ok">● 已连接管理员接口</span>'}catch(e){byId('state').innerHTML='<span class="bad">'+esc(e.message)+'</span>'}}
  byId('connect').addEventListener('click',connect);
  byId('refresh').addEventListener('click',function(){load().catch(function(e){alert(e.message)})});
  byId('status').addEventListener('change',function(){load().catch(function(e){alert(e.message)})});
  byId('publish').addEventListener('click',async function(){try{await api('/api/admin/tasks',{method:'POST',body:JSON.stringify({post_id:byId('postId').value,post_link:byId('link').value,post_text:byId('text').value,note:byId('note').value,priority:Number(byId('priority').value||0)})});byId('link').value='';byId('postId').value='';byId('text').value='';byId('note').value='';await load()}catch(e){alert(e.message)}});
  byId('tasks').addEventListener('click',async function(e){var button=e.target.closest('.cancel-task');if(!button)return;if(!confirm('确定取消这个任务？'))return;try{await api('/api/admin/tasks/'+encodeURIComponent(button.dataset.taskId)+'/cancel',{method:'POST',body:'{}'});await load()}catch(err){alert(err.message)}});
  if(tokenEl.value)connect();
  setInterval(function(){if(tokenEl.value)load().catch(function(){})},15000);
})();
</script></body></html>`;
}

app.get('/', (req, res) => res.redirect('/user'));
app.get('/user', (req, res) => res.type('html').send(userPage()));
app.get('/admin', (req, res) => res.type('html').send(adminPage()));

app.listen(PORT, HOST, () => {
  console.log(`[Comment Assistant] http://${HOST}:${PORT}/user`);
  console.log(`[Comment Assistant] Admin: http://${HOST}:${PORT}/admin`);
  console.log(`[Comment Assistant] Profiles=${PROFILE_ROOT}`);
  console.log(`[Comment Assistant] Admin=${ADMIN_TOKEN ? 'enabled' : 'disabled (set COMMENT_ADMIN_TOKEN)'}`);
});
