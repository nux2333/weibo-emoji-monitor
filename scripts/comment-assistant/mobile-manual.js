'use strict';

const express = require('express');
const os = require('os');
const { db, initDatabase } = require('../../src/db');

const HOST = String(process.env.COMMENT_MOBILE_HOST || '127.0.0.1');
const PORT = Number(process.env.COMMENT_MOBILE_PORT || 3014);
const TOKEN = String(process.env.COMMENT_API_TOKEN || '').trim();

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
  if (!worker || !account) return res.status(400).json({ success: false, message: 'worker/account required' });

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

  if (!taskId || !worker || !account) return res.status(400).json({ success: false, message: 'taskId/worker/account required' });
  if (!['done', 'skip'].includes(action)) return res.status(400).json({ success: false, message: 'action must be done or skip' });

  const row = db.prepare(`SELECT task_id, status
    FROM comment_assistant_task_assignments
    WHERE task_id = ? AND worker_id = ? AND account = ?`).get(taskId, worker, account);

  if (!row) return res.status(404).json({ success: false, message: '任务不存在' });
  if (row.status !== 'CLAIMED') return res.status(409).json({ success: false, message: `当前状态=${row.status}，不能重复处理` });

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

function page() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Comment Assistant Mobile</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f6f8;color:#202124;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.wrap{max-width:680px;margin:0 auto;padding:14px}.card{background:#fff;border-radius:16px;padding:16px;margin-bottom:12px;box-shadow:0 2px 12px rgba(0,0,0,.06)}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.muted{color:#777;font-size:13px}.title{font-size:20px;font-weight:700}.progress{font-size:28px;font-weight:700;margin:4px 0 12px}.post{font-size:16px;line-height:1.65;white-space:pre-wrap;word-break:break-word;min-height:120px;background:#fafafa;border-radius:12px;padding:14px}.note{margin-top:10px;font-size:13px;color:#666;white-space:pre-wrap}.input{width:100%;font-size:17px;padding:14px;border:1px solid #d7d7d7;border-radius:12px;outline:none}.btn{width:100%;border:0;border-radius:12px;padding:14px 12px;font-size:16px;font-weight:600;color:#fff;background:#111}.btn.secondary{background:#6b7280}.btn.blue{background:#1677ff}.btn:disabled{opacity:.45}.gap{height:8px}.hidden{display:none}.ok{color:#15803d}.bad{color:#b91c1c}select,input{font:inherit}.top-input{flex:1;min-width:140px;padding:10px;border:1px solid #ccc;border-radius:9px}.account-select{width:100%;padding:11px;border:1px solid #ccc;border-radius:10px;background:#fff}.link{display:inline-block;margin-top:10px;color:#1677ff;text-decoration:none}.status{min-height:20px;margin-top:8px}.hint{font-size:12px;color:#888;margin-top:8px}
</style></head><body><div class="wrap">
<div class="card"><div class="title">手机手动任务</div><div class="row" style="margin-top:12px"><input id="token" class="top-input" type="password" placeholder="API Token"><input id="worker" class="top-input" placeholder="Worker，例如 PC-A"><button id="connect" class="btn blue" style="width:auto;padding:10px 16px" type="button">连接</button></div><div id="health" class="muted status">JS 加载中...</div></div>
<div class="card"><div class="muted">账号</div><select id="account" class="account-select"><option value="">请先连接</option></select></div>
<div id="taskCard" class="card hidden"><div id="progress" class="progress">0 / 0</div><div id="post" class="post"></div><div id="note" class="note"></div><a id="link" class="link" href="#">查看帖子</a><div class="gap"></div><input id="manualText" class="input" autocomplete="off" placeholder="手动记录；按 Enter = 确认完成并下一条"><div class="hint">Enter 只代表手动确认完成，不会自动向微博提交评论。</div><div class="gap"></div><button id="done" class="btn blue" type="button">完成并下一条</button><div class="gap"></div><button id="skip" class="btn secondary" type="button">跳过并下一条</button><div id="status" class="status muted"></div></div>
<div id="empty" class="card hidden"><div class="title">这个账号没有待处理任务了</div><div id="emptyProgress" class="muted" style="margin-top:8px"></div></div>
</div><script>
(function(){
  function el(id){return document.getElementById(id)}
  var token=el('token'),worker=el('worker'),account=el('account'),taskCard=el('taskCard'),empty=el('empty'),currentTask=null;
  el('health').textContent='JS 已启动，等待连接';
  token.value=sessionStorage.getItem('caToken')||'';
  worker.value=localStorage.getItem('caWorker')||'';

  window.addEventListener('error',function(e){el('health').innerHTML='<span class="bad">JS错误：'+String(e.message||'unknown')+'</span>'});
  window.addEventListener('unhandledrejection',function(e){var msg=e.reason&&e.reason.message?e.reason.message:String(e.reason||'Promise error');el('health').innerHTML='<span class="bad">请求错误：'+msg+'</span>'});

  async function api(url,opt){
    opt=opt||{};
    var headers=Object.assign({'Content-Type':'application/json','Authorization':'Bearer '+token.value.trim()},opt.headers||{});
    var r=await fetch(url,Object.assign({},opt,{headers:headers}));
    var j;
    try{j=await r.json()}catch(_){j={success:false,message:'HTTP '+r.status}}
    if(!r.ok||!j.success)throw new Error(j.message||('HTTP '+r.status));
    return j.data;
  }

  function progressText(p){var total=Number(p.total_count||0),done=Number(p.done_count||0),skip=Number(p.skipped_count||0),pending=Number(p.pending_count||0);return {main:(done+skip)+' / '+total,detail:'完成 '+done+' ｜ 跳过 '+skip+' ｜ 剩余 '+pending}}
  function setStatus(text,bad){el('status').textContent=text||'';el('status').className='status '+(bad?'bad':'muted')}

  async function loadAccounts(){
    var list=await api('/api/accounts?worker='+encodeURIComponent(worker.value.trim()));
    account.innerHTML='';
    if(!list.length){var o=document.createElement('option');o.value='';o.textContent='暂无已领取任务';account.appendChild(o);taskCard.classList.add('hidden');empty.classList.remove('hidden');return}
    list.forEach(function(x){var o=document.createElement('option');o.value=x.account;o.textContent=x.account+'（剩余 '+Number(x.pending_count||0)+'）';account.appendChild(o)});
    var saved=localStorage.getItem('caMobileAccount');if(saved&&list.some(function(x){return x.account===saved}))account.value=saved;
    await loadNext();
  }

  async function loadNext(){
    if(!account.value){taskCard.classList.add('hidden');empty.classList.remove('hidden');return}
    localStorage.setItem('caMobileAccount',account.value);
    var data=await api('/api/next?worker='+encodeURIComponent(worker.value.trim())+'&account='+encodeURIComponent(account.value));
    var p=progressText(data.progress||{});currentTask=data.task;
    if(!currentTask){taskCard.classList.add('hidden');empty.classList.remove('hidden');el('emptyProgress').textContent=p.detail;return}
    empty.classList.add('hidden');taskCard.classList.remove('hidden');el('progress').textContent=p.main;el('post').textContent=currentTask.post_text||'(无帖子文案)';el('note').textContent=(currentTask.note||'')+'\n'+p.detail;
    var link=el('link');if(currentTask.post_link){link.style.display='inline-block';link.href=currentTask.post_link}else{link.style.display='none';link.href='#'}
    el('manualText').value='';setStatus('');
  }

  async function finish(action){
    if(!currentTask)return;el('done').disabled=true;el('skip').disabled=true;
    try{await api('/api/task/'+encodeURIComponent(currentTask.task_id)+'/result',{method:'POST',body:JSON.stringify({worker:worker.value.trim(),account:account.value,action:action,manual_text:el('manualText').value})});await loadNext()}catch(e){setStatus(e.message,true)}finally{el('done').disabled=false;el('skip').disabled=false}
  }

  async function connect(){
    el('health').textContent='连接中...';
    sessionStorage.setItem('caToken',token.value.trim());localStorage.setItem('caWorker',worker.value.trim());
    if(!token.value.trim()){el('health').innerHTML='<span class="bad">请先输入 API Token</span>';return}
    if(!worker.value.trim()){el('health').innerHTML='<span class="bad">请先输入 Worker 名称</span>';return}
    try{var h=await api('/api/health');el('health').innerHTML='<span class="ok">● 已连接</span> '+h.host;await loadAccounts()}catch(e){el('health').innerHTML='<span class="bad">连接失败：'+String(e.message)+'</span>'}
  }

  el('connect').onclick=connect;
  account.onchange=function(){loadNext().catch(function(e){el('health').innerHTML='<span class="bad">'+String(e.message)+'</span>'})};
  el('done').onclick=function(){finish('done')};
  el('skip').onclick=function(){finish('skip')};
  el('link').onclick=function(e){if(!currentTask||!currentTask.post_link){e.preventDefault();return}window.location.href=currentTask.post_link};
  el('manualText').onkeydown=function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();finish('done')}};
})();
</script></body></html>`;
}

app.get('/', (req, res) => res.type('html').send(page()));

app.listen(PORT, HOST, () => {
  console.log(`[Comment Assistant Mobile] http://${HOST}:${PORT}/`);
  console.log('[Comment Assistant Mobile] Enter = 手动确认当前任务完成并进入下一条');
});
