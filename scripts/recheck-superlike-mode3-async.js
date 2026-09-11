const path = require('path');
const { Pool } = require('pg');
const { createBatchLogger } = require('../src/batch-logger');
const { ProxyPool } = require('../src/proxy-pool');
const {
  buildLightProfileApiUrl,
  profileTextHasSuperLike,
  checkSuperLikeByBrowser
} = require('../src/superlike/mode3-profile');

const ROUND_INTERVAL_MS = Number(process.env.SUPERLIKE_MODE3_ROUND_INTERVAL_MS) || 2 * 60 * 1000;
const BATCH_SIZE = Number(process.env.SUPERLIKE_PROFILE_VERIFY_BATCH_SIZE) || 300;
const REQUEST_DELAY_MS = Number(process.env.SUPERLIKE_LIGHT_REQUEST_DELAY_MS) || 250;
const REQUEST_TIMEOUT_MS = Number(process.env.SUPERLIKE_LIGHT_REQUEST_TIMEOUT_MS) || 10000;
const HTTP_CONCURRENCY = Math.max(1, Math.min(20, Number(process.env.SUPERLIKE_MODE3_HTTP_CONCURRENCY) || 8));
const HTTP_PROBE_SIZE = Math.max(5, Math.min(100, Number(process.env.SUPERLIKE_MODE3_HTTP_PROBE_SIZE) || 30));
const CHROMIUM_PROXY_RETRIES = Math.max(1, Math.min(10, Number(process.env.SUPERLIKE_MODE3_CHROMIUM_PROXY_RETRIES) || 3));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Math.max(2, Number(process.env.PG_MODE3_POOL_MAX) || 6),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  allowExitOnIdle: false
});

const proxyPool = new ProxyPool({
  filePath: process.env.WEIBO_GOOD_PROXY_FILE || path.join(__dirname, '..', 'data', 'weibo-good-proxies.txt'),
  dynamicSource: '',
  rawPool: process.env.SUPERLIKE_MODE3_PROXY_POOL || '',
  fallback: process.env.SUPERLIKE_MODE3_PROXY || '',
  cooldownMs: Number(process.env.SUPERLIKE_PROXY_COOLDOWN_MS) || 30 * 60 * 1000,
  name: 'mode3-async'
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function memoryMB(value) {
  return Math.round(Number(value || 0) / 1024 / 1024);
}

function logMemory(label) {
  const m = process.memoryUsage();
  console.log(
    `[模式3][Memory][${label}] RSS=${memoryMB(m.rss)}MB | Heap=${memoryMB(m.heapUsed)}/${memoryMB(m.heapTotal)}MB | External=${memoryMB(m.external)}MB | ` +
    `PG total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}`
  );
}

function parseMonitorConfig(url) {
  const match = String(url || '').match(/100808([a-f0-9]{32})/i);
  if (!match) throw new Error(`无法从超话URL解析 page_id: ${url}`);
  const pageId = `100808${match[1]}`;
  return { pageId, profileContainerId: `231140${match[1]}_-_profile_inpage` };
}

async function getMonitors() {
  const result = await pool.query(`
    SELECT id, name, url FROM monitors
    WHERE COALESCE(enabled, 1) <> 0 AND monitor_type = 'superlike'
    ORDER BY id
  `);
  return result.rows;
}

async function getUsers(monitorId) {
  const result = await pool.query(`
    SELECT p.uid, MAX(p.username) AS username, COUNT(*)::int AS post_count,
      MAX(COALESCE(p.moved_flag, 0)) AS has_moved_post, MAX(p.id) AS latest_id,
      MIN(p.first_seen_at) AS first_seen_at,
      MAX(p.profile_last_checked_at) AS profile_last_checked_at,
      MAX(p.experience_7d) AS experience_7d
    FROM superlike_posts p
    WHERE p.monitor_id = $1 AND p.uid IS NOT NULL AND p.uid <> ''
      AND CAST(p.first_seen_at AS date) = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date
      AND NOT EXISTS (SELECT 1 FROM superlike_users su WHERE su.uid = p.uid)
    GROUP BY p.uid
    HAVING MAX(p.experience_7d) >= 70
    ORDER BY MAX(p.experience_7d) DESC,
      CASE WHEN MAX(p.profile_last_checked_at) IS NULL THEN 0 ELSE 1 END ASC,
      CAST(MAX(p.profile_last_checked_at) AS timestamp) ASC NULLS FIRST,
      CAST(MIN(p.first_seen_at) AS timestamp) ASC, MAX(p.id) DESC
    LIMIT $2
  `, [monitorId, BATCH_SIZE]);
  return result.rows;
}

async function markProfileChecked(monitorId, uid, status) {
  await pool.query(`UPDATE superlike_posts SET profile_last_checked_at = CURRENT_TIMESTAMP, profile_status = $1 WHERE monitor_id = $2 AND uid = $3`, [status, monitorId, uid]);
}

async function graduateUser(monitorId, uid) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO superlike_users(monitor_id, uid, scan_date) VALUES($1, $2, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::text) ON CONFLICT(uid) DO NOTHING`, [monitorId, uid]);
    const deleted = await client.query(`DELETE FROM superlike_posts WHERE monitor_id = $1 AND uid = $2 RETURNING id`, [monitorId, uid]);
    if (deleted.rowCount > 0) {
      await client.query(`INSERT INTO superlike_pool_exit_events(monitor_id, uid, exit_date, reason, exited_at) VALUES($1, $2, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::text, 'BECAME_SUPERLIKE', CURRENT_TIMESTAMP)`, [monitorId, uid]);
    }
    await client.query('COMMIT');
    return deleted.rowCount;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

function compactBody(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

async function checkByHttp(config, uid) {
  const url = buildLightProfileApiUrl(config, uid);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: 'follow', signal: controller.signal,
      headers: {
        'Accept': 'application/json,text/plain,*/*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152 Safari/537.36',
        'Referer': 'https://m.weibo.cn/'
      }
    });
    const finalUrl = String(response.url || url);
    const text = await response.text();
    const detail = { finalUrl, bodySample: compactBody(text) };

    if (finalUrl.includes('visitor.passport.weibo.cn')) return { ok: false, fallback: true, status: response.status, message: 'HTTP跳转visitor.passport', ...detail };
    if (!response.ok) return { ok: false, fallback: true, status: response.status, message: `HTTP ${response.status}`, ...detail };

    let json;
    try { json = JSON.parse(text); } catch {
      return { ok: false, fallback: true, status: response.status, message: 'HTTP返回非JSON', ...detail };
    }
    if (Number(json?.ok ?? 0) !== 1) return { ok: false, fallback: true, status: response.status, message: `API ok=${json?.ok}`, ...detail };
    return { ok: true, source: 'HTTP', status: response.status, hasSuperLike: profileTextHasSuperLike(text), ...detail };
  } catch (error) {
    return { ok: false, fallback: true, status: null, message: error?.name === 'AbortError' ? 'HTTP超时' : `HTTP异常: ${error.message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function toPlaywrightProxy(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const value = { server: `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}` };
    if (u.username) value.username = decodeURIComponent(u.username);
    if (u.password) value.password = decodeURIComponent(u.password);
    return value;
  } catch { return { server: raw }; }
}

async function acquireProxy() {
  try {
    if (typeof proxyPool.getNext === 'function') {
      const raw = await proxyPool.getNext();
      if (raw) return { raw, proxy: toPlaywrightProxy(raw), masked: String(raw).replace(/:\/\/([^:@]+):([^@]+)@/, '://***:***@') };
    }
    if (typeof proxyPool.acquire === 'function') {
      const value = await proxyPool.acquire();
      if (value?.raw || value?.proxy) return value;
    }
  } catch (error) { console.log(`[模式3][Proxy] 获取代理失败：${error.message}`); }
  return { raw: null, proxy: null, masked: 'LOCAL' };
}

function isProxyNetworkFailure(result) {
  const msg = String(result?.message || '');
  return result?.blocked || /ERR_CERT_AUTHORITY_INVALID|ERR_SOCKS_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_EMPTY_RESPONSE|ERR_CONNECTION_(?:RESET|CLOSED|REFUSED)|net::ERR_|Failed to fetch/i.test(msg);
}

async function createBrowserFallback() {
  const { chromium } = require('playwright');
  let browser = null;
  let assignment = null;

  async function close() {
    if (browser) { try { await browser.close(); } catch {} browser = null; }
  }

  async function discardCurrent(reason) {
    if (assignment?.raw) {
      try { proxyPool.remove(assignment.raw); } catch {}
      console.log(`[模式3][Chromium兜底] 淘汰代理 ${assignment.masked} | ${reason}`);
    }
    await close();
  }

  async function launch() {
    await close();
    assignment = await acquireProxy();
    console.log(`[模式3][Chromium兜底] 启动 | ${assignment?.masked || 'LOCAL'}`);
    browser = await chromium.launch({ headless: true, ...(assignment?.proxy ? { proxy: assignment.proxy } : {}) });
    return browser;
  }

  return {
    async check(config, uid) {
      let lastResult = null;
      for (let attempt = 1; attempt <= CHROMIUM_PROXY_RETRIES; attempt++) {
        if (!browser) await launch();
        try {
          lastResult = await checkSuperLikeByBrowser(browser, config, uid, null, '模式3兜底');
        } catch (error) {
          lastResult = { ok: false, status: null, message: error.message };
        }
        if (lastResult?.ok) return { ...lastResult, source: 'CHROMIUM' };
        if (!isProxyNetworkFailure(lastResult) || !assignment?.raw) break;
        const reason = lastResult?.message || `status=${lastResult?.status ?? '-'}`;
        await discardCurrent(reason);
        if (attempt < CHROMIUM_PROXY_RETRIES) console.log(`[模式3][Chromium兜底] 切换代理重试 UID=${uid} | ${attempt + 1}/${CHROMIUM_PROXY_RETRIES}`);
      }
      return { ...lastResult, source: 'CHROMIUM' };
    },
    close
  };
}

function summarizeHttpProbe(results) {
  const counts = new Map();
  let ok = 0;
  for (const r of results) {
    if (r?.ok) ok++;
    const key = r?.ok ? `SUCCESS_${r.status || 200}` : (r?.message || 'UNKNOWN');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return { ok, summary: Array.from(counts.entries()).map(([k, v]) => `${k}=${v}`).join(' | ') };
}

async function runRound(round) {
  const startedAt = Date.now();
  const monitors = await getMonitors();
  const stats = { users: 0, httpTried: 0, httpOk: 0, httpSkipped: 0, fallback: 0, checked: 0, superlike: 0, deleted: 0, failed: 0 };
  const browserFallback = await createBrowserFallback();

  console.log('');
  console.log(`[Recheck] ===== 模式3 Async 第${round}轮开始 =====`);
  console.log(`[模式3] async pg.Pool | HTTP诊断样本=${HTTP_PROBE_SIZE} 并发=${HTTP_CONCURRENCY} | Chromium失败兜底 | UID上限=${BATCH_SIZE}`);
  logMemory('ROUND_START');

  try {
    for (const monitor of monitors) {
      const config = parseMonitorConfig(monitor.url);
      const users = await getUsers(monitor.id);
      stats.users += users.length;
      console.log(`[模式3] Monitor=${monitor.name} | UID=${users.length} | 条件=今天入库+jyz>=70 | 顺序=jyz DESC`);
      if (!users.length) continue;
      console.log('[模式3][队列TOP] ' + users.slice(0, 10).map(x => `${x.uid}(jyz=${x.experience_7d ?? '-'})`).join(' | '));

      // 先固定抽样一批 UID 做真正的 Node fetch，明确验证 HTTP 是否可用。
      // 如果样本一个成功都没有，就不再让剩余几百个 UID 重复撞同一种 HTTP 风控。
      const probeSize = Math.min(HTTP_PROBE_SIZE, users.length);
      console.log(`[模式3][HTTP诊断] 开始 Node fetch 抽样 ${probeSize} 个 UID；先看是否存在任何成功，不预设必须 Chromium`);
      const probeResults = await mapLimit(users.slice(0, probeSize), HTTP_CONCURRENCY, async user => {
        const result = await checkByHttp(config, String(user.uid));
        if (REQUEST_DELAY_MS > 0) await sleep(Math.min(REQUEST_DELAY_MS, 100));
        return result;
      });
      stats.httpTried += probeResults.length;
      const probe = summarizeHttpProbe(probeResults);
      stats.httpOk += probe.ok;
      console.log(`[模式3][HTTP诊断] 样本=${probeSize} | 成功=${probe.ok} | ${probe.summary || '无结果'}`);
      for (let i = 0; i < Math.min(3, probeResults.length); i++) {
        const r = probeResults[i];
        console.log(`[模式3][HTTP样本 ${i + 1}] UID=${users[i].uid} | ${r?.ok ? '成功' : (r?.message || '失败')} | status=${r?.status ?? '-'} | final=${r?.finalUrl || '-'} | body=${r?.bodySample || '-'}`);
      }

      const httpUsable = probe.ok > 0;
      if (!httpUsable && users.length > probeSize) {
        stats.httpSkipped += users.length - probeSize;
        console.log(`[模式3][HTTP诊断] ${probeSize} 个样本 0 成功 → 本轮剩余 ${users.length - probeSize} 个跳过 HTTP，直接 Chromium；下轮仍会重新抽样验证`);
      } else if (httpUsable) {
        console.log(`[模式3][HTTP诊断] 已确认 Node fetch 可以成功，本轮剩余 UID 继续 HTTP-first`);
      }

      let remainingHttpResults = [];
      if (httpUsable && users.length > probeSize) {
        remainingHttpResults = await mapLimit(users.slice(probeSize), HTTP_CONCURRENCY, async user => {
          const result = await checkByHttp(config, String(user.uid));
          if (REQUEST_DELAY_MS > 0) await sleep(Math.min(REQUEST_DELAY_MS, 100));
          return result;
        });
        stats.httpTried += remainingHttpResults.length;
        stats.httpOk += remainingHttpResults.filter(r => r?.ok).length;
      }

      for (let i = 0; i < users.length; i++) {
        const uid = String(users[i].uid || '').trim();
        let result = i < probeSize ? probeResults[i] : (httpUsable ? remainingHttpResults[i - probeSize] : null);

        if (!result?.ok) {
          stats.fallback++;
          const reason = result ? (result.message || '失败') : 'HTTP诊断判定本轮不可用';
          console.log(`[模式3][HTTP ${i + 1}/${users.length}] UID=${uid} | ${reason} → Chromium兜底`);
          try { result = await browserFallback.check(config, uid); }
          catch (error) { result = { ok: false, status: null, source: 'CHROMIUM', message: error.message }; }
        }

        if (!result?.ok) {
          stats.failed++;
          console.log(`[模式3][${result?.source || 'CHECK'} ${i + 1}/${users.length}] UID=${uid} | 失败 | ${result?.message || 'unknown'}`);
          if (Number(result?.status) !== 403 && !String(result?.message || '').includes('visitor.passport')) await markProfileChecked(monitor.id, uid, 'PROFILE_FAILED');
          continue;
        }

        stats.checked++;
        await markProfileChecked(monitor.id, uid, result.hasSuperLike ? 'SUPERLIKE' : 'NO_SUPERLIKE');
        if (result.hasSuperLike) {
          stats.superlike++;
          const deleted = await graduateUser(monitor.id, uid);
          stats.deleted += deleted;
          console.log(`[模式3][${result.source} ${i + 1}/${users.length}] UID=${uid} | SuperLike=是 | 删除=${deleted}`);
        } else {
          console.log(`[模式3][${result.source} ${i + 1}/${users.length}] UID=${uid} | SuperLike=否 | 保留`);
        }
      }
    }
  } finally {
    await browserFallback.close();
  }

  const elapsed = Date.now() - startedAt;
  logMemory('ROUND_END');
  console.log(`========== 模式3 Async 第${round}轮完成 ==========`);
  console.log(`UID=${stats.users} | HTTP尝试=${stats.httpTried} | HTTP直接成功=${stats.httpOk} | HTTP跳过=${stats.httpSkipped} | Chromium兜底=${stats.fallback} | 成功=${stats.checked} | SuperLike=${stats.superlike} | 删除=${stats.deleted} | 失败=${stats.failed}`);
  console.log(`耗时=${Math.round(elapsed / 1000)}秒 | HTTP实际命中率=${stats.httpTried ? (stats.httpOk * 100 / stats.httpTried).toFixed(1) : '0.0'}%`);
  console.log('==============================================');
  return elapsed;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('缺少 DATABASE_URL');
  createBatchLogger('recheck-superlike', 'mode3');
  console.log('[模式3] 新架构：原生 async PostgreSQL + HTTP诊断探针 + lazy Chromium fallback + 坏代理自动轮换');
  console.log(`[模式3] PG pool max=${pool.options.max} | HTTP并发=${HTTP_CONCURRENCY} | HTTP样本=${HTTP_PROBE_SIZE} | Chromium代理重试=${CHROMIUM_PROXY_RETRIES} | round=${ROUND_INTERVAL_MS / 1000}s`);

  let round = 0;
  while (true) {
    round++;
    try {
      const elapsed = await runRound(round);
      const waitMs = Math.max(0, ROUND_INTERVAL_MS - elapsed);
      if (waitMs > 0) await sleep(waitMs);
    } catch (error) {
      console.error(`[模式3] 第${round}轮异常：`, error);
      await sleep(Math.min(ROUND_INTERVAL_MS, 30000));
    }
  }
}

main().catch(async error => {
  console.error('[模式3] 致命异常：', error);
  try { await pool.end(); } catch {}
  process.exit(1);
});
