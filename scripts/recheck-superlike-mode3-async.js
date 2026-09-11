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
  if (!match) {
    throw new Error(`无法从超话URL解析 page_id: ${url}`);
  }
  const pageId = `100808${match[1]}`;
  return {
    pageId,
    profileContainerId: `231140${match[1]}_-_profile_inpage`
  };
}

async function getMonitors() {
  const result = await pool.query(`
    SELECT id, name, url
    FROM monitors
    WHERE COALESCE(enabled, 1) <> 0
      AND monitor_type = 'superlike'
    ORDER BY id
  `);
  return result.rows;
}

async function getUsers(monitorId) {
  const result = await pool.query(`
    SELECT
      p.uid,
      MAX(p.username) AS username,
      COUNT(*)::int AS post_count,
      MAX(COALESCE(p.moved_flag, 0)) AS has_moved_post,
      MAX(p.id) AS latest_id,
      MIN(p.first_seen_at) AS first_seen_at,
      MAX(p.profile_last_checked_at) AS profile_last_checked_at,
      MAX(p.experience_7d) AS experience_7d
    FROM superlike_posts p
    WHERE p.monitor_id = $1
      AND p.uid IS NOT NULL
      AND p.uid <> ''
      AND CAST(p.first_seen_at AS date) = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date
      AND NOT EXISTS (
        SELECT 1 FROM superlike_users su WHERE su.uid = p.uid
      )
    GROUP BY p.uid
    HAVING MAX(p.experience_7d) >= 70
    ORDER BY
      MAX(p.experience_7d) DESC,
      CASE WHEN MAX(p.profile_last_checked_at) IS NULL THEN 0 ELSE 1 END ASC,
      CAST(MAX(p.profile_last_checked_at) AS timestamp) ASC NULLS FIRST,
      CAST(MIN(p.first_seen_at) AS timestamp) ASC,
      MAX(p.id) DESC
    LIMIT $2
  `, [monitorId, BATCH_SIZE]);
  return result.rows;
}

async function markProfileChecked(monitorId, uid, status) {
  await pool.query(`
    UPDATE superlike_posts
    SET profile_last_checked_at = CURRENT_TIMESTAMP,
        profile_status = $1
    WHERE monitor_id = $2 AND uid = $3
  `, [status, monitorId, uid]);
}

async function graduateUser(monitorId, uid) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO superlike_users(monitor_id, uid, scan_date)
      VALUES($1, $2, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::text)
      ON CONFLICT(uid) DO NOTHING
    `, [monitorId, uid]);

    const deleted = await client.query(`
      DELETE FROM superlike_posts
      WHERE monitor_id = $1 AND uid = $2
      RETURNING id
    `, [monitorId, uid]);

    if (deleted.rowCount > 0) {
      await client.query(`
        INSERT INTO superlike_pool_exit_events(monitor_id, uid, exit_date, reason, exited_at)
        VALUES($1, $2,
          (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::text,
          'BECAME_SUPERLIKE', CURRENT_TIMESTAMP)
      `, [monitorId, uid]);
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

async function checkByHttp(config, uid) {
  const url = buildLightProfileApiUrl(config, uid);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json,text/plain,*/*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152 Safari/537.36',
        'Referer': 'https://m.weibo.cn/'
      }
    });
    const finalUrl = String(response.url || url);
    const text = await response.text();

    if (finalUrl.includes('visitor.passport.weibo.cn')) {
      return { ok: false, fallback: true, status: response.status, message: 'HTTP跳转visitor.passport' };
    }
    if (response.status === 418 || response.status === 403) {
      return { ok: false, fallback: true, status: response.status, message: `HTTP ${response.status}` };
    }
    if (!response.ok) {
      return { ok: false, fallback: true, status: response.status, message: `HTTP ${response.status}` };
    }

    let json;
    try { json = JSON.parse(text); } catch {
      return { ok: false, fallback: true, status: response.status, message: 'HTTP返回非JSON' };
    }
    if (Number(json?.ok ?? 0) !== 1) {
      return { ok: false, fallback: true, status: response.status, message: `API ok=${json?.ok}` };
    }
    return {
      ok: true,
      source: 'HTTP',
      status: response.status,
      hasSuperLike: profileTextHasSuperLike(text)
    };
  } catch (error) {
    return {
      ok: false,
      fallback: true,
      status: null,
      message: error?.name === 'AbortError' ? 'HTTP超时' : `HTTP异常: ${error.message}`
    };
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
  } catch {
    return { server: raw };
  }
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
  } catch (error) {
    console.log(`[模式3][Proxy] 获取代理失败：${error.message}`);
  }
  return { raw: null, proxy: null, masked: 'LOCAL' };
}

async function createBrowserFallback() {
  const { chromium } = require('playwright');
  let context = null;
  let assignment = null;

  async function close() {
    if (context) {
      try { await context.close(); } catch {}
      context = null;
    }
  }

  async function launch() {
    await close();
    assignment = await acquireProxy();
    console.log(`[模式3][Chromium兜底] 启动 | ${assignment?.masked || 'LOCAL'}`);
    context = await chromium.launch({
      headless: true,
      ...(assignment?.proxy ? { proxy: assignment.proxy } : {})
    });
    return context;
  }

  return {
    async check(config, uid) {
      if (!context) await launch();
      let result = await checkSuperLikeByBrowser(context, config, uid, null, '模式3兜底');
      if (!result?.ok && result?.blocked && assignment?.raw) {
        try { proxyPool.remove(assignment.raw); } catch {}
        console.log(`[模式3][Chromium兜底] ${assignment.masked} 命中418，切换代理重试 UID=${uid}`);
        await launch();
        result = await checkSuperLikeByBrowser(context, config, uid, null, '模式3兜底');
      }
      return { ...result, source: 'CHROMIUM' };
    },
    close
  };
}

async function runRound(round) {
  const startedAt = Date.now();
  const monitors = await getMonitors();
  const stats = { users: 0, httpOk: 0, fallback: 0, checked: 0, superlike: 0, deleted: 0, failed: 0 };
  const browserFallback = await createBrowserFallback();

  console.log('');
  console.log(`[Recheck] ===== 模式3 Async 第${round}轮开始 =====`);
  console.log(`[模式3] async pg.Pool | HTTP-first并发=${HTTP_CONCURRENCY} | Chromium仅失败兜底 | UID上限=${BATCH_SIZE}`);
  logMemory('ROUND_START');

  try {
    for (const monitor of monitors) {
      const config = parseMonitorConfig(monitor.url);
      const users = await getUsers(monitor.id);
      stats.users += users.length;
      console.log(`[模式3] Monitor=${monitor.name} | UID=${users.length} | 条件=今天入库+jyz>=70 | 顺序=jyz DESC`);
      if (!users.length) continue;

      console.log('[模式3][队列TOP] ' + users.slice(0, 10).map(x => `${x.uid}(jyz=${x.experience_7d ?? '-'})`).join(' | '));

      const httpResults = await mapLimit(users, HTTP_CONCURRENCY, async user => {
        const result = await checkByHttp(config, String(user.uid));
        if (REQUEST_DELAY_MS > 0) await sleep(Math.min(REQUEST_DELAY_MS, 100));
        return result;
      });

      for (let i = 0; i < users.length; i++) {
        const uid = String(users[i].uid || '').trim();
        let result = httpResults[i];

        if (result?.ok) {
          stats.httpOk++;
        } else {
          stats.fallback++;
          console.log(`[模式3][HTTP ${i + 1}/${users.length}] UID=${uid} | ${result?.message || '失败'} → Chromium兜底`);
          try {
            result = await browserFallback.check(config, uid);
          } catch (error) {
            result = { ok: false, status: null, source: 'CHROMIUM', message: error.message };
          }
        }

        if (!result?.ok) {
          stats.failed++;
          console.log(`[模式3][${result?.source || 'CHECK'} ${i + 1}/${users.length}] UID=${uid} | 失败 | ${result?.message || 'unknown'}`);
          // 403 / visitor 风控不写 PROFILE_FAILED；其他真实失败才记录。
          if (Number(result?.status) !== 403 && !String(result?.message || '').includes('visitor.passport')) {
            await markProfileChecked(monitor.id, uid, 'PROFILE_FAILED');
          }
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
  console.log(`UID=${stats.users} | HTTP直接成功=${stats.httpOk} | Chromium兜底=${stats.fallback} | 成功=${stats.checked} | SuperLike=${stats.superlike} | 删除=${stats.deleted} | 失败=${stats.failed}`);
  console.log(`耗时=${Math.round(elapsed / 1000)}秒 | HTTP命中率=${stats.users ? (stats.httpOk * 100 / stats.users).toFixed(1) : '0.0'}%`);
  console.log('==============================================');
  return elapsed;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('缺少 DATABASE_URL');
  createBatchLogger('recheck-superlike', 'mode3');
  console.log('[模式3] 新架构：原生 async PostgreSQL + HTTP-first + lazy Chromium fallback');
  console.log(`[模式3] PG pool max=${pool.options.max} | HTTP并发=${HTTP_CONCURRENCY} | round=${ROUND_INTERVAL_MS / 1000}s`);

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

process.on('SIGINT', async () => {
  try { await pool.end(); } catch {}
  process.exit(0);
});
process.on('SIGTERM', async () => {
  try { await pool.end(); } catch {}
  process.exit(0);
});

main().catch(async error => {
  console.error('[模式3] 致命错误：', error);
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});
