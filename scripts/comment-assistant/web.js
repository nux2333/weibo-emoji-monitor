const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PROFILE_ROOT = path.join(ROOT, 'data', 'comment-assistant-profiles');
const LEGACY_PROFILE_DIR = path.join(ROOT, 'data', 'comment-assistant-profile');
const HOST = String(process.env.COMMENT_ASSISTANT_UI_HOST || '127.0.0.1');
const PORT = Number(process.env.COMMENT_ASSISTANT_UI_PORT || 3011);

fs.mkdirSync(PROFILE_ROOT, { recursive: true });

const app = express();
app.use(express.json({ limit: '32kb' }));

let child = null;
let currentAccount = null;
let logs = [];
let startedAt = null;
let exitCode = null;

function sanitizeAccount(value) {
  const name = String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  return name || null;
}

function pushLog(text) {
  if (!text) return;
  logs.push(String(text));
  if (logs.length > 500) logs = logs.slice(-500);
}

function listAccounts() {
  const names = new Set();
  try {
    for (const entry of fs.readdirSync(PROFILE_ROOT, { withFileTypes: true })) {
      if (entry.isDirectory()) names.add(entry.name);
    }
  } catch {}

  if (fs.existsSync(LEGACY_PROFILE_DIR)) names.add('default');
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

function processState() {
  return {
    running: Boolean(child && !child.killed && child.exitCode === null),
    account: currentAccount,
    pid: child?.pid || null,
    startedAt,
    exitCode,
    logs: logs.join('')
  };
}

function startAssistant(account) {
  if (child && child.exitCode === null) {
    throw new Error('评论助手正在运行，请先退出当前任务');
  }

  const safeAccount = sanitizeAccount(account);
  if (!safeAccount) throw new Error('账号名称无效');

  const script = path.join(__dirname, 'index.js');
  const preload = path.join(ROOT, 'src', 'postgres-preload.js');
  logs = [];
  currentAccount = safeAccount;
  startedAt = new Date().toISOString();
  exitCode = null;

  child = spawn(process.execPath, ['-r', preload, script], {
    cwd: ROOT,
    env: {
      ...process.env,
      COMMENT_ACCOUNT: safeAccount
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  pushLog(`[UI] 已启动账号 ${safeAccount} | PID=${child.pid}\n`);
  child.stdout.on('data', data => pushLog(data.toString('utf8')));
  child.stderr.on('data', data => pushLog(data.toString('utf8')));
  child.on('error', error => pushLog(`[UI] 进程错误：${error.message}\n`));
  child.on('exit', code => {
    exitCode = code;
    pushLog(`[UI] 进程结束，exitCode=${code}\n`);
  });
}

app.get('/api/accounts', (req, res) => {
  res.json({ success: true, data: listAccounts() });
});

app.get('/api/status', (req, res) => {
  res.json({ success: true, data: processState() });
});

app.post('/api/start', (req, res) => {
  try {
    startAssistant(req.body?.account);
    res.json({ success: true, data: processState() });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.post('/api/action', (req, res) => {
  try {
    if (!child || child.exitCode !== null || child.killed) {
      throw new Error('当前没有运行中的评论助手');
    }

    const action = String(req.body?.action || '').trim().toLowerCase();
    const mapping = { send: 'y', skip: 's', quit: 'q' };
    const value = mapping[action];
    if (!value) throw new Error('不支持的操作');

    child.stdin.write(`${value}\n`);
    res.json({ success: true, action });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>微博评论助手</title>
<style>
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f5f6f8;color:#222}.wrap{max-width:980px;margin:24px auto;padding:0 16px}.card{background:#fff;border-radius:14px;padding:18px;margin-bottom:16px;box-shadow:0 2px 12px rgba(0,0,0,.06)}h1{font-size:22px;margin:0 0 14px}label{display:block;font-size:13px;color:#666;margin-bottom:6px}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:end}select,input,button{font:inherit}select,input{padding:9px 10px;border:1px solid #ccc;border-radius:8px;min-width:180px}button{border:0;border-radius:8px;padding:10px 16px;cursor:pointer}.start{background:#111;color:#fff}.send{background:#1677ff;color:#fff}.skip{background:#eee}.quit{background:#d4380d;color:#fff}button:disabled{opacity:.45;cursor:not-allowed}.status{font-size:14px;line-height:1.7}.log{white-space:pre-wrap;background:#111;color:#ddd;border-radius:10px;padding:14px;min-height:360px;max-height:60vh;overflow:auto;font:12px/1.55 Consolas,monospace}.hint{font-size:13px;color:#666;line-height:1.7}
</style>
</head>
<body><div class="wrap">
<div class="card"><h1>微博评论助手</h1><div class="hint">每个账号使用独立 Profile 保存登录状态。首次使用某个账号，或登录过期时，才会弹出 Chrome 让你手动登录。</div></div>
<div class="card"><div class="row"><div><label>已有账号</label><select id="accounts"></select></div><div><label>新账号名称</label><input id="newAccount" placeholder="例如 account2"></div><button class="start" id="startBtn">启动</button></div></div>
<div class="card"><div class="status" id="status">读取状态...</div><div class="row" style="margin-top:12px"><button class="send" id="sendBtn">发送 y</button><button class="skip" id="skipBtn">跳过 s</button><button class="quit" id="quitBtn">退出 q</button></div></div>
<div class="card"><div class="log" id="log"></div></div>
</div>
<script>
const $=id=>document.getElementById(id);let lastLog='';
async function json(url,opt){const r=await fetch(url,opt);const j=await r.json();if(!j.success)throw new Error(j.message||'请求失败');return j;}
async function loadAccounts(){const j=await json('/api/accounts');const s=$('accounts');s.innerHTML='';for(const a of j.data){const o=document.createElement('option');o.value=a;o.textContent=a;s.appendChild(o)}if(!j.data.length){const o=document.createElement('option');o.value='default';o.textContent='default';s.appendChild(o)}}
async function refresh(){try{const j=await json('/api/status');const d=j.data;const running=!!d.running;$('status').textContent=running?('运行中 | 账号='+d.account+' | PID='+d.pid):('未运行'+(d.exitCode!==null?' | 上次 exitCode='+d.exitCode:''));$('sendBtn').disabled=!running;$('skipBtn').disabled=!running;$('quitBtn').disabled=!running;$('startBtn').disabled=running;if(d.logs!==lastLog){lastLog=d.logs;$('log').textContent=d.logs;$('log').scrollTop=$('log').scrollHeight}}catch(e){$('status').textContent=e.message}}
$('startBtn').onclick=async()=>{const account=$('newAccount').value.trim()||$('accounts').value||'default';try{await json('/api/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account})});$('newAccount').value='';await loadAccounts();await refresh()}catch(e){alert(e.message)}};
async function action(a){try{await json('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:a})});await refresh()}catch(e){alert(e.message)}}
$('sendBtn').onclick=()=>action('send');$('skipBtn').onclick=()=>action('skip');$('quitBtn').onclick=()=>action('quit');
loadAccounts().then(refresh);setInterval(refresh,1000);
</script></body></html>`);
});

app.listen(PORT, HOST, () => {
  console.log(`[comment-assistant-ui] http://${HOST}:${PORT}`);
  console.log('[comment-assistant-ui] 仅监听本机，不对外网开放');
});
