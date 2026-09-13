'use strict';

const express = require('express');
const os = require('os');
const { db, initDatabase } = require('../../src/db');

const HOST = String(process.env.COMMENT_WORKER_API_HOST || '127.0.0.1');
const PORT = Number(process.env.COMMENT_WORKER_API_PORT || 3012);
const TOKEN = String(process.env.COMMENT_API_TOKEN || '').trim();
const CLAIM_TTL_MS = Math.max(60_000, Number(process.env.COMMENT_CLAIM_TTL_MS || 10 * 60_000));
const WORKER_TTL_MS = Math.max(30_000, Number(process.env.COMMENT_WORKER_TTL_MS || 2 * 60_000));

if (!TOKEN) {
  console.error('[Comment Worker API] COMMENT_API_TOKEN 未设置，拒绝启动。');
  process.exit(1);
}

initDatabase();
db.exec(`CREATE TABLE IF NOT EXISTS comment_assistant_history (
  account TEXT NOT NULL,
  post_id TEXT NOT NULL,
  commented_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account, post_id)
)`);

const app = express();
app.use(express.json({ limit: '64kb' }));

const workers = new Map();
const claims = new Map();

function formatShanghaiDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

function cleanupState() {
  const now = Date.now();
  for (const [key, worker] of workers) {
    if (!worker || now - worker.lastSeenAt > WORKER_TTL_MS) workers.delete(key);
  }
  for (const [postId, claim] of claims) {
    if (!claim || claim.expiresAt <= now) claims.delete(postId);
  }
}

function workerKey(worker) {
  return String(worker || '').trim().slice(0, 120);
}

function touchWorker(worker, patch = {}) {
  const key = workerKey(worker);
  if (!key) return null;
  const previous = workers.get(key) || {};
  const next = {
    worker: key,
    account: String(patch.account ?? previous.account ?? '').trim(),
    status: String(patch.status ?? previous.status ?? 'online').trim().slice(0, 80),
    note: String(patch.note ?? previous.note ?? '').trim().slice(0, 300),
    lastSeenAt: Date.now()
  };
  workers.set(key, next);
  return next;
}

function auth(req, res, next) {
  const value = String(req.headers.authorization || '');
  if (value !== `Bearer ${TOKEN}`) {
    return res.status(401).json({ success: false, message: 'unauthorized' });
  }
  next();
}

function getTargets(account, limit, worker) {
  cleanupState();
  const safeLimit = Math.max(1, Math.min(Number(limit || 20), 100));
  const today = formatShanghaiDate(new Date());
  const rows = db.prepare(`SELECT post_id, uid, username, post_link, post_text, experience_7d,
    comments_count, initial_comments_count, post_created_at, first_seen_at
    FROM superlike_posts
    WHERE COALESCE(current_has_superlike, 0) = 0
      AND experience_7d IS NOT NULL AND experience_7d >= 70
      AND COALESCE(comments_count, 0) <= 19
      AND post_link IS NOT NULL AND TRIM(post_link) <> ''
      AND post_created_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM black_fan_users b
        WHERE CAST(b.uid AS TEXT) = CAST(superlike_posts.uid AS TEXT)
      )
      AND NOT EXISTS (
        SELECT 1 FROM comment_assistant_history h
        WHERE h.account = ? AND CAST(h.post_id AS TEXT) = CAST(superlike_posts.post_id AS TEXT)
      )
    ORDER BY experience_7d DESC, first_seen_at DESC`).all(account);

  const now = Date.now();
  const key = workerKey(worker);
  const picked = [];
  for (const row of rows) {
    if (formatShanghaiDate(row.post_created_at) !== today) continue;
    const postId = String(row.post_id);
    const existing = claims.get(postId);
    if (existing && existing.expiresAt > now && existing.worker !== key) continue;
    claims.set(postId, { worker: key, account, expiresAt: now + CLAIM_TTL_MS });
    picked.push(row);
    if (picked.length >= safeLimit) break;
  }
  return picked;
}

app.get('/api/comment-worker/health', auth, (req, res) => {
  cleanupState();
  res.json({ success: true, data: {
    host: os.hostname(),
    now: new Date().toISOString(),
    workers: workers.size,
    claims: claims.size
  }});
});

app.post('/api/comment-worker/heartbeat', auth, (req, res) => {
  const worker = touchWorker(req.body?.worker, {
    account: req.body?.account,
    status: req.body?.status,
    note: req.body?.note
  });
  if (!worker) return res.status(400).json({ success: false, message: 'worker required' });
  res.json({ success: true, data: worker });
});

app.get('/api/comment-worker/workers', auth, (req, res) => {
  cleanupState();
  const data = Array.from(workers.values())
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .map(item => ({ ...item, lastSeenAt: new Date(item.lastSeenAt).toISOString() }));
  res.json({ success: true, data });
});

app.post('/api/comment-worker/claim', auth, (req, res) => {
  const account = String(req.body?.account || '').trim();
  const worker = workerKey(req.body?.worker);
  const limit = Number(req.body?.limit || 20);
  if (!account) return res.status(400).json({ success: false, message: 'account required' });
  if (!worker) return res.status(400).json({ success: false, message: 'worker required' });
  touchWorker(worker, { account, status: 'reading-candidates' });
  const items = getTargets(account, limit, worker);
  res.json({ success: true, data: { account, worker, claim_ttl_ms: CLAIM_TTL_MS, items } });
});

app.post('/api/comment-worker/release', auth, (req, res) => {
  const worker = workerKey(req.body?.worker);
  const postId = String(req.body?.post_id || '').trim();
  if (!worker || !postId) return res.status(400).json({ success: false, message: 'worker and post_id required' });
  const claim = claims.get(postId);
  if (claim?.worker === worker) claims.delete(postId);
  res.json({ success: true });
});

app.post('/api/comment-worker/commented', auth, (req, res) => {
  const account = String(req.body?.account || '').trim();
  const postId = String(req.body?.post_id || '').trim();
  const worker = workerKey(req.body?.worker);
  if (!account || !postId) return res.status(400).json({ success: false, message: 'account and post_id required' });
  db.prepare(`INSERT INTO comment_assistant_history (account, post_id, commented_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (account, post_id) DO NOTHING`).run(account, postId);
  claims.delete(postId);
  if (worker) touchWorker(worker, { account, status: 'online' });
  res.json({ success: true });
});

app.get('/api/comment-worker/history', auth, (req, res) => {
  const account = String(req.query.account || '').trim();
  const limit = Math.max(1, Math.min(Number(req.query.limit || 50), 200));
  if (!account) return res.status(400).json({ success: false, message: 'account required' });
  const rows = db.prepare(`SELECT account, post_id, commented_at
    FROM comment_assistant_history
    WHERE account = ?
    ORDER BY commented_at DESC
    LIMIT ?`).all(account, limit);
  const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM comment_assistant_history WHERE account = ?').get(account);
  res.json({ success: true, data: { account, count: Number(countRow?.cnt || 0), items: rows } });
});

app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Comment Assistant Remote</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:#f5f6f8;color:#222}.wrap{max-width:1100px;margin:20px auto;padding:0 14px}.card{background:#fff;border-radius:14px;padding:16px;margin-bottom:14px;box-shadow:0 2px 12px rgba(0,0,0,.06)}h1,h2{margin:0 0 12px}h1{font-size:22px}h2{font-size:17px}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:end}label{display:block;font-size:12px;color:#666;margin-bottom:5px}input,button{font:inherit;padding:9px 10px;border-radius:8px}input{border:1px solid #ccc;min-width:180px}button{border:0;background:#111;color:#fff;cursor:pointer}.muted{font-size:13px;color:#666}.ok{color:#15803d}.bad{color:#b91c1c}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}.box{border:1px solid #eee;border-radius:10px;padding:10px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:8px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}a{color:#1677ff;text-decoration:none}.scroll{overflow:auto;max-height:55vh}.mono{font-family:Consolas,monospace;font-size:12px}
</style></head><body><div class="wrap">
<div class="card"><h1>Comment Assistant Remote</h1><div class="muted">只读候选/Worker 状态/历史同步控制台。Token 只保存在当前浏览器 sessionStorage。</div></div>
<div class="card"><div class="row"><div><label>API Token</label><input id="token" type="password" placeholder="COMMENT_API_TOKEN"></div><button id="save">连接</button></div><div id="health" class="muted" style="margin-top:10px">未连接</div></div>
<div class="card"><h2>在线 Worker</h2><div id="workers" class="grid"></div></div>
<div class="card"><h2>账号候选</h2><div class="row"><div><label>账号</label><input id="account" placeholder="例如 account5"></div><div><label>数量</label><input id="limit" type="number" value="20" min="1" max="100" style="min-width:90px"></div><button id="load">读取候选</button><button id="historyBtn">读取历史</button></div><div id="summary" class="muted" style="margin:10px 0"></div><div class="scroll"><table><thead><tr><th>经验值</th><th>用户</th><th>评论</th><th>帖子</th><th>文案</th></tr></thead><tbody id="rows"></tbody></table></div></div>
</div><script>
const $=id=>document.getElementById(id);$('token').value=sessionStorage.getItem('commentApiToken')||'';
async function api(path,opt={}){const token=$('token').value.trim();const r=await fetch(path,{...opt,headers:{'Content-Type':'application/json','Authorization':'Bearer '+token,...(opt.headers||{})}});const j=await r.json().catch(()=>({success:false,message:'HTTP '+r.status}));if(!r.ok||!j.success)throw new Error(j.message||('HTTP '+r.status));return j.data}
async function health(){try{const d=await api('/api/comment-worker/health');$('health').innerHTML='<span class="ok">已连接</span> | Host='+d.host+' | Workers='+d.workers+' | Claims='+d.claims+' | '+d.now;await loadWorkers()}catch(e){$('health').innerHTML='<span class="bad">'+e.message+'</span>'}}
async function loadWorkers(){try{const list=await api('/api/comment-worker/workers');$('workers').innerHTML=list.length?list.map(w=>'<div class="box"><b>'+esc(w.worker)+'</b><br>账号：'+esc(w.account||'-')+'<br>状态：'+esc(w.status||'-')+'<br><span class="muted">'+esc(w.lastSeenAt)+'</span></div>').join(''):'<div class="muted">暂无在线 Worker</div>'}catch(e){$('workers').textContent=e.message}}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
$('save').onclick=()=>{sessionStorage.setItem('commentApiToken',$('token').value.trim());health()};
$('load').onclick=async()=>{try{const account=$('account').value.trim(),limit=Number($('limit').value||20);const worker='h5-'+Math.random().toString(36).slice(2,8);const d=await api('/api/comment-worker/claim',{method:'POST',body:JSON.stringify({account,limit,worker})});$('summary').textContent='候选 '+d.items.length+' 条 | claim '+Math.round(d.claim_ttl_ms/1000)+' 秒';$('rows').innerHTML=d.items.map(x=>'<tr><td>'+esc(x.experience_7d)+'</td><td>'+esc(x.username||x.uid)+'</td><td>'+esc(x.comments_count)+'</td><td><a target="_blank" href="'+esc(x.post_link)+'">打开</a><div class="mono">'+esc(x.post_id)+'</div></td><td>'+esc(x.post_text||'')+'</td></tr>').join('')}catch(e){alert(e.message)}};
$('historyBtn').onclick=async()=>{try{const account=$('account').value.trim();const d=await api('/api/comment-worker/history?account='+encodeURIComponent(account)+'&limit=50');$('summary').textContent='历史评论记录：'+d.count+' 条';$('rows').innerHTML=d.items.map(x=>'<tr><td>-</td><td>'+esc(x.account)+'</td><td>-</td><td><span class="mono">'+esc(x.post_id)+'</span></td><td>'+esc(x.commented_at)+'</td></tr>').join('')}catch(e){alert(e.message)}};
if($('token').value)health();setInterval(()=>{if($('token').value)health()},10000);
</script></body></html>`);
});

app.listen(PORT, HOST, () => {
  console.log(`[Comment Worker API] http://${HOST}:${PORT}`);
  console.log(`[Comment Worker API] ClaimTTL=${CLAIM_TTL_MS}ms | WorkerTTL=${WORKER_TTL_MS}ms`);
  console.log('[Comment Worker API] 必须通过 Bearer COMMENT_API_TOKEN 访问 API；H5 页面本身不包含 Token。');
});
