'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { db, initDatabase } = require('../../src/db');

const ROOT = path.join(__dirname, '..', '..');
const PROFILE_ROOT = path.join(ROOT, 'data', 'comment-assistant-profiles');
const LEGACY_PROFILE_DIR = path.join(ROOT, 'data', 'comment-assistant-profile');
const HOST = String(process.env.COMMENT_WORKER_API_HOST || '127.0.0.1');
const PORT = Number(process.env.COMMENT_WORKER_API_PORT || 3012);
const TOKEN = String(process.env.COMMENT_API_TOKEN || '').trim();
const ADMIN_TOKEN = String(process.env.COMMENT_ADMIN_TOKEN || '').trim();
const WORKER_TTL_MS = Math.max(30_000, Number(process.env.COMMENT_WORKER_TTL_MS || 2 * 60_000));

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
    result.push({ name: 'default', legacy: true, initialized: hasProfileData(LEGACY_PROFILE_DIR) });
  }
  try {
    const names = fs.readdirSync(PROFILE_ROOT, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' }));
    for (const name of names) {
      result.push({ name, legacy: false, initialized: hasProfileData(path.join(PROFILE_ROOT, name)) });
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
  return { name: safe, legacy: false, initialized: false };
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

app.get('/api/health', userAuth, (req, res) => {
  cleanupWorkers();
  const taskStats = db.prepare(`SELECT status, COUNT(*) AS cnt FROM comment_assistant_tasks GROUP BY status`).all();
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

app.post('/api/heartbeat', userAuth, (req, res) => {
  const worker = touchWorker(req.body?.worker, {
    account: req.body?.account,
    status: req.body?.status,
    note: req.body?.note
  });
  if (!worker) return res.status(400).json({ success: false, message: 'worker required' });
  res.json({ success: true, data: worker });
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

app.post('/api/tasks/claim', userAuth, (req, res) => {
  const worker = workerKey(req.body?.worker);
  const accounts = Array.isArray(req.body?.accounts) ? req.body.accounts.map(sanitizeAccount).filter(Boolean) : [];
  const loops = Math.max(1, Math.min(Number(req.body?.loops || 1), 20));
  if (!worker) return res.status(400).json({ success: false, message: 'worker required' });
  if (!accounts.length) return res.status(400).json({ success: false, message: '至少选择一个账号' });

  const maxTasks = Math.min(accounts.length * loops, 200);
  const openTasks = db.prepare(`SELECT task_id, post_id, post_link, post_text, note, priority
    FROM comment_assistant_tasks
    WHERE status = 'OPEN'
    ORDER BY priority DESC, created_at ASC
    LIMIT ?`).all(maxTasks);

  const claimed = [];
  for (let i = 0; i < openTasks.length; i++) {
    const task = openTasks[i];
    const account = accounts[i % accounts.length];
    try {
      db.prepare(`INSERT INTO comment_assistant_task_assignments
        (task_id, worker_id, account, status, claimed_at)
        VALUES (?, ?, ?, 'CLAIMED', LOCALTIMESTAMP)`).run(task.task_id, worker, account);
      db.prepare(`UPDATE comment_assistant_tasks SET status = 'CLAIMED', updated_at = LOCALTIMESTAMP
        WHERE task_id = ? AND status = 'OPEN'`).run(task.task_id);
      claimed.push({ ...task, account });
    } catch (_) {
      // 其他用户可能刚领取，忽略该条即可。
    }
  }
  touchWorker(worker, { account: accounts.join(','), status: claimed.length ? 'tasks-claimed' : 'idle', note: `领取 ${claimed.length} 条` });
  res.json({ success: true, data: { worker, loops, accounts, count: claimed.length, items: claimed } });
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
  let rows;
  if (status) {
    rows = db.prepare(`SELECT t.*, a.worker_id, a.account, a.claimed_at, a.completed_at, a.result
      FROM comment_assistant_tasks t
      LEFT JOIN comment_assistant_task_assignments a ON a.task_id = t.task_id
      WHERE t.status = ? ORDER BY t.priority DESC, t.created_at DESC LIMIT 500`).all(status);
  } else {
    rows = db.prepare(`SELECT t.*, a.worker_id, a.account, a.claimed_at, a.completed_at, a.result
      FROM comment_assistant_tasks t
      LEFT JOIN comment_assistant_task_assignments a ON a.task_id = t.task_id
      ORDER BY t.created_at DESC LIMIT 500`).all();
  }
  res.json({ success: true, data: rows });
});

app.post('/api/admin/tasks', adminAuth, (req, res) => {
  const postLink = String(req.body?.post_link || '').trim();
  const postId = String(req.body?.post_id || '').trim();
  const postText = String(req.body?.post_text || '').trim().slice(0, 4000);
  const note = String(req.body?.note || '').trim().slice(0, 1000);
  const priority = Math.max(-999, Math.min(Number(req.body?.priority || 0), 999));
  if (!postLink) return res.status(400).json({ success: false, message: 'post_link required' });
  const taskId = makeTaskId();
  db.prepare(`INSERT INTO comment_assistant_tasks
    (task_id, post_id, post_link, post_text, note, priority, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, 'OPEN', 'admin')`).run(taskId, postId || null, postLink, postText || null, note || null, priority);
  res.json({ success: true, data: { task_id: taskId } });
});

app.post('/api/admin/tasks/:taskId/cancel', adminAuth, (req, res) => {
  const taskId = String(req.params.taskId || '').trim();
  db.prepare(`UPDATE comment_assistant_tasks SET status = 'CANCELLED', updated_at = LOCALTIMESTAMP WHERE task_id = ?`).run(taskId);
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
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:#f5f6f8;color:#222}.wrap{max-width:1180px;margin:18px auto;padding:0 14px}.card{background:#fff;border-radius:14px;padding:16px;margin-bottom:14px;box-shadow:0 2px 12px rgba(0,0,0,.06)}h1,h2{margin:0 0 12px}.top{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}.row{display:flex;gap:10px;align-items:end;flex-wrap:wrap}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}.box{border:1px solid #e8e8e8;border-radius:10px;padding:10px}input,select,button,textarea{font:inherit;padding:9px 10px;border-radius:8px}input,select,textarea{border:1px solid #ccc;background:#fff}button{border:0;background:#111;color:#fff;cursor:pointer}.blue{background:#1677ff}.green{background:#15803d}.gray{background:#6b7280}.red{background:#b91c1c}.muted{font-size:13px;color:#666}.ok{color:#15803d}.warn{color:#b45309}.bad{color:#b91c1c}.accounts{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px}.account{border:1px solid #e5e7eb;border-radius:9px;padding:10px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:8px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}.scroll{overflow:auto;max-height:58vh}a{color:#1677ff;text-decoration:none}.log{background:#111;color:#ddd;border-radius:10px;padding:10px;min-height:130px;max-height:260px;overflow:auto;font-family:Consolas,monospace;font-size:12px;white-space:pre-wrap}.pill{display:inline-block;border-radius:999px;padding:2px 8px;background:#eef2ff;font-size:12px}
`;

function userPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Comment Assistant 用户端</title><style>${baseCss}</style></head><body><div class="wrap">
<div class="card"><div class="top"><div><h1>Comment Assistant 用户端</h1><div class="muted">账号管理、任务领取、处理记录</div></div><a href="/admin">管理员画面 →</a></div></div>
<div class="card"><div class="row"><div><div class="muted">API Token</div><input id="token" type="password"></div><div><div class="muted">本机名称</div><input id="worker" placeholder="例如 PC-A"></div><button id="connect">连接</button><button class="blue" id="add">＋ 添加微博账号</button></div><div id="health" class="muted" style="margin-top:10px">未连接</div></div>
<div class="card"><div class="top"><h2>当前可执行账号</h2><span id="accountCount" class="pill">0</span></div><div id="accounts" class="accounts"></div><div class="row" style="margin-top:12px"><div><div class="muted">Loop 回数</div><input id="loops" type="number" min="1" max="20" value="1" style="width:80px"></div><button class="green" id="claim">领取任务</button></div><div class="muted" style="margin-top:8px">第一版中“领取任务”会按所选账号与 Loop 回数生成待处理队列；帖子处理仍由用户打开后完成。</div></div>
<div class="card"><h2>执行结果 / 我的任务</h2><div class="scroll"><table><thead><tr><th>账号</th><th>状态</th><th>帖子</th><th>备注</th><th>操作</th></tr></thead><tbody id="tasks"></tbody></table></div></div>
<div class="card"><h2>执行 Log</h2><div id="log" class="log"></div></div>
</div><script>
const $=id=>document.getElementById(id);$('token').value=sessionStorage.getItem('caToken')||'';$('worker').value=localStorage.getItem('caWorker')||('PC-'+Math.random().toString(36).slice(2,6));
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function log(s){$('log').textContent+='['+new Date().toLocaleTimeString()+'] '+s+'\n';$('log').scrollTop=$('log').scrollHeight}
async function api(path,opt={}){const r=await fetch(path,{...opt,headers:{'Content-Type':'application/json','Authorization':'Bearer '+$('token').value.trim(),...(opt.headers||{})}});const j=await r.json().catch(()=>({success:false,message:'HTTP '+r.status}));if(!r.ok||!j.success)throw new Error(j.message||('HTTP '+r.status));return j.data}
async function loadAccounts(){const list=await api('/api/accounts');$('accountCount').textContent=list.length;$('accounts').innerHTML=list.map(x=>'<label class="account"><input type="checkbox" class="acct" value="'+esc(x.name)+'"> <b>'+esc(x.name)+'</b><br><span class="'+(x.initialized?'ok':'warn')+'">'+(x.initialized?'● 已有登录数据':'○ 未初始化')+'</span></label>').join('')||'<div class="muted">暂无账号</div>'}
async function loadTasks(){const worker=$('worker').value.trim();if(!worker)return;const list=await api('/api/my-tasks?worker='+encodeURIComponent(worker));$('tasks').innerHTML=list.map(x=>'<tr><td>'+esc(x.account||'-')+'</td><td>'+esc(x.assignment_status||x.status)+'</td><td><a target="_blank" href="'+esc(x.post_link)+'">打开帖子</a><br><span class="muted">'+esc(x.post_text||'')+'</span></td><td>'+esc(x.note||'')+'</td><td>'+(x.assignment_status==='CLAIMED'?'<button class="green" onclick="finish(\''+esc(x.task_id)+'\',\'DONE\')">完成</button> <button class="gray" onclick="finish(\''+esc(x.task_id)+'\',\'SKIPPED\')">跳过</button>':'-')+'</td></tr>').join('')||'<tr><td colspan="5" class="muted">暂无任务</td></tr>'}
async function heartbeat(){try{await api('/api/heartbeat',{method:'POST',body:JSON.stringify({worker:$('worker').value.trim(),status:'online'})})}catch(_){} }
async function connect(){sessionStorage.setItem('caToken',$('token').value.trim());localStorage.setItem('caWorker',$('worker').value.trim());try{const h=await api('/api/health');$('health').innerHTML='<span class="ok">● 已连接</span> | Host='+esc(h.host)+' | Accounts='+h.accounts+' | Workers='+h.workers;await loadAccounts();await loadTasks();await heartbeat();log('连接成功')}catch(e){$('health').innerHTML='<span class="bad">'+esc(e.message)+'</span>';log('连接失败：'+e.message)}}
$('connect').onclick=connect;$('add').onclick=async()=>{const name=prompt('新微博账号名称');if(!name)return;try{const a=await api('/api/accounts',{method:'POST',body:JSON.stringify({name})});log('已创建账号目录：'+a.name);await loadAccounts();alert('账号目录已创建。首次扫码登录仍需在执行电脑上初始化 Chromium Profile。')}catch(e){alert(e.message)}};
$('claim').onclick=async()=>{const accounts=[...document.querySelectorAll('.acct:checked')].map(x=>x.value);const loops=Number($('loops').value||1);try{const d=await api('/api/tasks/claim',{method:'POST',body:JSON.stringify({worker:$('worker').value.trim(),accounts,loops})});log('领取任务 '+d.count+' 条，账号='+accounts.join(',')+'，Loop='+loops);await loadTasks()}catch(e){alert(e.message);log('领取失败：'+e.message)}};
window.finish=async(taskId,status)=>{try{await api('/api/tasks/'+encodeURIComponent(taskId)+'/result',{method:'POST',body:JSON.stringify({worker:$('worker').value.trim(),status})});log('任务 '+taskId+' → '+status);await loadTasks()}catch(e){alert(e.message)}};
if($('token').value)connect();setInterval(()=>{if($('token').value){heartbeat();loadTasks().catch(()=>{})}},15000);
</script></body></html>`;
}

function adminPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Comment Assistant 管理员</title><style>${baseCss}</style></head><body><div class="wrap">
<div class="card"><div class="top"><div><h1>Comment Assistant 管理员</h1><div class="muted">发布任务、查看领取与完成状态</div></div><a href="/user">← 用户画面</a></div></div>
<div class="card"><div class="row"><div><div class="muted">Admin Token</div><input id="token" type="password"></div><button id="connect">连接</button></div><div id="state" class="muted" style="margin-top:8px">未连接</div></div>
<div class="card"><h2>发布任务</h2><div class="row"><input id="postId" placeholder="Post ID（可选）"><input id="link" placeholder="帖子链接" style="min-width:320px"><input id="priority" type="number" value="0" placeholder="优先级" style="width:90px"></div><div class="row" style="margin-top:8px"><textarea id="text" placeholder="帖子文案/说明（可选）" rows="2" style="min-width:320px"></textarea><textarea id="note" placeholder="任务备注（可选）" rows="2" style="min-width:260px"></textarea><button class="blue" id="publish">发布任务</button></div></div>
<div class="card"><div class="top"><h2>任务列表</h2><div><select id="status"><option value="">全部</option><option>OPEN</option><option>CLAIMED</option><option>DONE</option><option>SKIPPED</option><option>CANCELLED</option></select> <button id="refresh">刷新</button></div></div><div class="scroll"><table><thead><tr><th>状态</th><th>优先级</th><th>帖子</th><th>领取人</th><th>账号</th><th>结果</th><th>操作</th></tr></thead><tbody id="tasks"></tbody></table></div></div>
<div class="card"><h2>在线 Worker</h2><div id="workers" class="grid"></div></div>
</div><script>
const $=id=>document.getElementById(id);$('token').value=sessionStorage.getItem('caAdminToken')||'';function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function api(path,opt={}){const r=await fetch(path,{...opt,headers:{'Content-Type':'application/json','Authorization':'Bearer '+$('token').value.trim(),...(opt.headers||{})}});const j=await r.json().catch(()=>({success:false,message:'HTTP '+r.status}));if(!r.ok||!j.success)throw new Error(j.message||('HTTP '+r.status));return j.data}
async function load(){const q=$('status').value?'?status='+encodeURIComponent($('status').value):'';const list=await api('/api/admin/tasks'+q);$('tasks').innerHTML=list.map(x=>'<tr><td>'+esc(x.status)+'</td><td>'+esc(x.priority)+'</td><td><a target="_blank" href="'+esc(x.post_link)+'">打开</a><br><span class="muted">'+esc(x.post_text||'')+'</span></td><td>'+esc(x.worker_id||'-')+'</td><td>'+esc(x.account||'-')+'</td><td>'+esc(x.result||'-')+'</td><td>'+(x.status!=='CANCELLED'&&x.status!=='DONE'?'<button class="red" onclick="cancelTask(\''+esc(x.task_id)+'\')">取消</button>':'-')+'</td></tr>').join('')||'<tr><td colspan="7" class="muted">暂无任务</td></tr>';const ws=await api('/api/admin/workers');$('workers').innerHTML=ws.map(w=>'<div class="box"><b>'+esc(w.worker)+'</b><br>账号：'+esc(w.account||'-')+'<br>状态：'+esc(w.status||'-')+'<br><span class="muted">'+esc(w.lastSeenAt)+'</span></div>').join('')||'<div class="muted">暂无在线 Worker</div>'}
$('connect').onclick=async()=>{sessionStorage.setItem('caAdminToken',$('token').value.trim());try{await load();$('state').innerHTML='<span class="ok">● 已连接管理员接口</span>'}catch(e){$('state').innerHTML='<span class="bad">'+esc(e.message)+'</span>'}};$('refresh').onclick=()=>load().catch(e=>alert(e.message));$('status').onchange=()=>load().catch(e=>alert(e.message));
$('publish').onclick=async()=>{try{await api('/api/admin/tasks',{method:'POST',body:JSON.stringify({post_id:$('postId').value,post_link:$('link').value,post_text:$('text').value,note:$('note').value,priority:Number($('priority').value||0)})});$('link').value='';$('postId').value='';$('text').value='';$('note').value='';await load()}catch(e){alert(e.message)}};window.cancelTask=async id=>{if(!confirm('确定取消这个任务？'))return;await api('/api/admin/tasks/'+encodeURIComponent(id)+'/cancel',{method:'POST',body:'{}'});await load()};if($('token').value)$('connect').click();setInterval(()=>{if($('token').value)load().catch(()=>{})},15000);
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
