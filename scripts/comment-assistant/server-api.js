'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { db, initDatabase } = require('../../src/db');

const ROOT = path.join(__dirname, '..', '..');
const HOST = String(process.env.COMMENT_WORKER_API_HOST || '127.0.0.1');
const PORT = Number(process.env.COMMENT_WORKER_API_PORT || 3012);
const TOKEN = String(process.env.COMMENT_API_TOKEN || '').trim();
const GOOD_PROXY_FILE = process.env.WEIBO_GOOD_PROXY_FILE
  ? path.resolve(process.env.WEIBO_GOOD_PROXY_FILE)
  : path.join(ROOT, 'data', 'weibo-good-proxies.txt');
const LEASE_MS = Math.max(60_000, Number(process.env.COMMENT_PROXY_LEASE_MS || 20 * 60_000));
const COOLDOWN_MS = Math.max(60_000, Number(process.env.COMMENT_PROXY_COOLDOWN_MS || 10 * 60_000));

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

const leases = new Map();
const cooldowns = new Map();

function normalizeProxy(rawValue) {
  const raw = String(rawValue || '').split('#')[0].trim();
  if (!raw) return null;
  return /^(?:https?|socks5):\/\//i.test(raw) ? raw : `http://${raw}`;
}

function readProxyPool() {
  try {
    if (!fs.existsSync(GOOD_PROXY_FILE)) return [];
    return Array.from(new Set(
      fs.readFileSync(GOOD_PROXY_FILE, 'utf8')
        .split(/\r?\n/)
        .map(normalizeProxy)
        .filter(Boolean)
    ));
  } catch (error) {
    console.warn(`[Comment Worker API] 代理池读取失败：${error.message}`);
    return [];
  }
}

function cleanupState() {
  const now = Date.now();
  for (const [proxy, lease] of leases) {
    if (!lease || lease.expiresAt <= now) leases.delete(proxy);
  }
  for (const [proxy, until] of cooldowns) {
    if (until <= now) cooldowns.delete(proxy);
  }
}

function leaseKey(worker, account) {
  return `${String(worker || '')}::${String(account || '')}`;
}

function findExistingLease(worker, account) {
  cleanupState();
  const key = leaseKey(worker, account);
  for (const [proxy, lease] of leases) {
    if (lease.key === key) return { proxy, lease };
  }
  return null;
}

function leaseProxy(worker, account) {
  cleanupState();
  const existing = findExistingLease(worker, account);
  if (existing) {
    existing.lease.expiresAt = Date.now() + LEASE_MS;
    return existing.proxy;
  }

  const pool = readProxyPool();
  if (!pool.length) return null;
  const now = Date.now();
  const available = pool.filter(proxy => !leases.has(proxy) && Number(cooldowns.get(proxy) || 0) <= now);
  if (!available.length) return null;
  const proxy = available[Math.floor(Math.random() * available.length)];
  leases.set(proxy, {
    key: leaseKey(worker, account),
    worker: String(worker || ''),
    account: String(account || ''),
    leasedAt: now,
    expiresAt: now + LEASE_MS
  });
  return proxy;
}

function releaseProxy(proxy, cooldown = false) {
  const normalized = normalizeProxy(proxy);
  if (!normalized) return;
  leases.delete(normalized);
  if (cooldown) cooldowns.set(normalized, Date.now() + COOLDOWN_MS);
}

function formatShanghaiDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

function getTargets(account, limit) {
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

  return rows
    .filter(row => formatShanghaiDate(row.post_created_at) === today)
    .sort((a, b) => {
      const e = Number(b.experience_7d || 0) - Number(a.experience_7d || 0);
      if (e !== 0) return e;
      const p = new Date(b.post_created_at).getTime() - new Date(a.post_created_at).getTime();
      if (Number.isFinite(p) && p !== 0) return p;
      return new Date(b.first_seen_at || 0).getTime() - new Date(a.first_seen_at || 0).getTime();
    })
    .slice(0, safeLimit);
}

function auth(req, res, next) {
  const value = String(req.headers.authorization || '');
  if (value !== `Bearer ${TOKEN}`) {
    return res.status(401).json({ success: false, message: 'unauthorized' });
  }
  next();
}

app.get('/api/comment-worker/health', auth, (req, res) => {
  cleanupState();
  res.json({
    success: true,
    data: {
      host: os.hostname(),
      proxyPool: readProxyPool().length,
      leased: leases.size,
      cooldown: cooldowns.size,
      now: new Date().toISOString()
    }
  });
});

app.post('/api/comment-worker/claim', auth, (req, res) => {
  const account = String(req.body?.account || '').trim();
  const worker = String(req.body?.worker || '').trim();
  const limit = Number(req.body?.limit || 20);
  if (!account) return res.status(400).json({ success: false, message: 'account required' });
  const items = getTargets(account, limit);
  res.json({ success: true, data: { account, worker, items } });
});

app.post('/api/comment-worker/commented', auth, (req, res) => {
  const account = String(req.body?.account || '').trim();
  const postId = String(req.body?.post_id || '').trim();
  if (!account || !postId) {
    return res.status(400).json({ success: false, message: 'account and post_id required' });
  }
  db.prepare(`INSERT INTO comment_assistant_history (account, post_id, commented_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (account, post_id) DO NOTHING`).run(account, postId);
  res.json({ success: true });
});

app.post('/api/comment-worker/proxy/lease', auth, (req, res) => {
  const worker = String(req.body?.worker || '').trim();
  const account = String(req.body?.account || '').trim();
  if (!worker || !account) return res.status(400).json({ success: false, message: 'worker and account required' });
  const proxy = leaseProxy(worker, account);
  if (!proxy) return res.status(503).json({ success: false, message: 'no proxy available' });
  res.json({ success: true, data: { proxy, lease_ms: LEASE_MS } });
});

app.post('/api/comment-worker/proxy/fail', auth, (req, res) => {
  const proxy = normalizeProxy(req.body?.proxy);
  if (proxy) releaseProxy(proxy, true);
  res.json({ success: true, data: { cooldown_ms: COOLDOWN_MS } });
});

app.post('/api/comment-worker/proxy/release', auth, (req, res) => {
  const proxy = normalizeProxy(req.body?.proxy);
  if (proxy) releaseProxy(proxy, false);
  res.json({ success: true });
});

app.listen(PORT, HOST, () => {
  console.log(`[Comment Worker API] http://${HOST}:${PORT}`);
  console.log(`[Comment Worker API] ProxyPool=${readProxyPool().length} | Lease=${LEASE_MS}ms | Cooldown=${COOLDOWN_MS}ms`);
  console.log('[Comment Worker API] 必须通过 Bearer COMMENT_API_TOKEN 访问。');
});
