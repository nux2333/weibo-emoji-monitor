const path = require('path');
const { Pool } = require('pg');
const { chromium, request } = require('playwright');
const { createBatchLogger } = require('../src/batch-logger');
const { ProxyPool } = require('../src/proxy-pool');
const { buildLightProfileApiUrl, profileTextHasSuperLike } = require('../src/superlike/mode3-profile');

const ROUND_INTERVAL_MS = Number(process.env.SUPERLIKE_MODE3_ROUND_INTERVAL_MS) || 2 * 60 * 1000;
const BATCH_SIZE = Number(process.env.SUPERLIKE_PROFILE_VERIFY_BATCH_SIZE) || 300;
const REQUEST_TIMEOUT_MS = Number(process.env.SUPERLIKE_LIGHT_REQUEST_TIMEOUT_MS) || 10000;
const HTTP_CONCURRENCY = Math.max(1, Math.min(20, Number(process.env.SUPERLIKE_MODE3_HTTP_CONCURRENCY) || 8));
const SESSION_BOOTSTRAP_TIMEOUT_MS = Number(process.env.SUPERLIKE_MODE3_SESSION_BOOTSTRAP_TIMEOUT_MS) || 15000;
const SESSION_PROXY_RETRIES = Math.max(1, Math.min(20, Number(process.env.SUPERLIKE_MODE3_SESSION_PROXY_RETRIES) || 10));
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Math.max(2, Number(process.env.PG_MODE3_POOL_MAX) || 6), idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000, allowExitOnIdle: false });
const proxyPool = new ProxyPool({
  filePath: process.env.WEIBO_GOOD_PROXY_FILE || path.join(__dirname, '..', 'data', 'weibo-good-proxies.txt'),
  cooldownMs: Number(process.env.SUPERLIKE_PROXY_COOLDOWN_MS) || 30 * 60 * 1000,
  name: 'mode3-session'
});

let visitorSession = null;
let sessionRefreshPromise = null;
let sessionGeneration = 0;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function memoryMB(value) { return Math.round(Number(value || 0) / 1024 / 1024); }
function logMemory(label) { const m = process.memoryUsage(); console.log(`[模式3][Memory][${label}] RSS=${memoryMB(m.rss)}MB | Heap=${memoryMB(m.heapUsed)}/${memoryMB(m.heapTotal)}MB | External=${memoryMB(m.external)}MB | PG total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}`); }
function compactBody(text) { return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 180); }
function cookieHeader(cookies) { return cookies.map(c => `${c.name}=${c.value}`).join('; '); }
function parseMonitorConfig(url) { const match = String(url || '').match(/100808([a-f0-9]{32})/i); if (!match) throw new Error(`无法从超话URL解析 page_id: ${url}`); return { pageId: `100808${match[1]}`, profileContainerId: `231140${match[1]}_-_profile_inpage` }; }
function isHttp4xx(status) { const n = Number(status); return Number.isFinite(n) && n >= 400 && n < 500; }
async function getMonitors() { return (await pool.query(`SELECT id, name, url FROM monitors WHERE COALESCE(enabled, 1) <> 0 AND monitor_type = 'superlike' ORDER BY id`)).rows; }
async function getUsers(monitorId) {
  return (await pool.query(`SELECT p.uid, MAX(p.username) AS username, COUNT(*)::int AS post_count, MAX(COALESCE(p.moved_flag, 0)) AS has_moved_post, MAX(p.id) AS latest_id, MIN(p.first_seen_at) AS first_seen_at, MAX(p.profile_last_checked_at) AS profile_last_checked_at, MAX(p.experience_7d) AS experience_7d FROM superlike_posts p WHERE p.monitor_id = $1 AND p.uid IS NOT NULL AND p.uid <> '' AND CAST(p.first_seen_at AS date) = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date AND NOT EXISTS (SELECT 1 FROM superlike_users su WHERE su.uid = p.uid) GROUP BY p.uid HAVING MAX(p.experience_7d) >= 70 ORDER BY MAX(p.experience_7d) DESC, CASE WHEN MAX(p.profile_last_checked_at) IS NULL THEN 0 ELSE 1 END ASC, CAST(MAX(p.profile_last_checked_at) AS timestamp) ASC NULLS FIRST, CAST(MIN(p.first_seen_at) AS timestamp) ASC, MAX(p.id) DESC LIMIT $2`, [monitorId, BATCH_SIZE])).rows;
}
async function markProfileChecked(monitorId, uid, status) { await pool.query(`UPDATE superlike_posts SET profile_last_checked_at = CURRENT_TIMESTAMP, profile_status = $1 WHERE monitor_id = $2 AND uid = $3`, [status, monitorId, uid]); }
async function graduateUser(monitorId, uid) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); await client.query(`INSERT INTO superlike_users(monitor_id, uid, scan_date) VALUES($1, $2, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::text) ON CONFLICT(uid) DO NOTHING`, [monitorId, uid]); const deleted = await client.query(`DELETE FROM superlike_posts WHERE monitor_id = $1 AND uid = $2 RETURNING id`, [monitorId, uid]); if (deleted.rowCount > 0) await client.query(`INSERT INTO superlike_pool_exit_events(monitor_id, uid, exit_date, reason, exited_at) VALUES($1, $2, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::text, 'BECAME_SUPERLIKE', CURRENT_TIMESTAMP)`, [monitorId, uid]); await client.query('COMMIT'); return deleted.rowCount; }
  catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
}
async function disposeSession(session) { if (!session) return; try { await session.apiContext?.dispose(); } catch {} }
async function acquireProxy() { const assignment = await proxyPool.acquire(); if (!assignment?.configured || !assignment.raw || !assignment.proxy) throw new Error('健康代理池当前没有可用代理'); return assignment; }

async function bootstrapVisitorSession(reason = '建立Session') {
  let lastError = null;
  for (let attempt = 1; attempt <= SESSION_PROXY_RETRIES; attempt++) {
    let assignment = null, browser = null, context = null;
    try {
      assignment = await acquireProxy();
      console.log(`[模式3][Session] ${reason} → 健康代理 ${assignment.masked} | ${attempt}/${SESSION_PROXY_RETRIES}`);
      browser = await chromium.launch({ headless: true, proxy: assignment.proxy });
      context = await browser.newContext({ userAgent: USER_AGENT, locale: 'zh-CN' });
      const page = await context.newPage();
      const response = await page.goto('https://m.weibo.cn/', { waitUntil: 'domcontentloaded', timeout: SESSION_BOOTSTRAP_TIMEOUT_MS });
      const firstStatus = response?.status();
      console.log(`[模式3][Session] 首页 status=${firstStatus ?? '-'} | final=${page.url()} | IP=${assignment.masked}`);
      if (isHttp4xx(firstStatus)) throw Object.assign(new Error(`Chromium首页 HTTP ${firstStatus}`), { blocked: true });
      await page.waitForTimeout(2500);
      if (page.url().includes('visitor.passport.weibo.cn')) {
        await page.waitForTimeout(2000);
        const second = await page.goto('https://m.weibo.cn/', { waitUntil: 'domcontentloaded', timeout: SESSION_BOOTSTRAP_TIMEOUT_MS });
        const secondStatus = second?.status();
        if (isHttp4xx(secondStatus)) throw Object.assign(new Error(`Chromium游客初始化 HTTP ${secondStatus}`), { blocked: true });
        await page.waitForTimeout(1500);
      }
      const cookies = await context.cookies(['https://m.weibo.cn/', 'https://weibo.cn/', 'https://weibo.com/']);
      const cookie = cookieHeader(cookies);
      if (!cookie) throw new Error('Chromium 未取得游客 Cookie');
      const userAgent = await page.evaluate(() => navigator.userAgent);
      const apiContext = await request.newContext({ userAgent, proxy: assignment.proxy, extraHTTPHeaders: { Accept: 'application/json,text/plain,*/*', Referer: 'https://m.weibo.cn/', Cookie: cookie } });
      const session = { cookie, userAgent, cookieNames: cookies.map(c => c.name), createdAt: Date.now(), generation: ++sessionGeneration, assignment, proxyLabel: assignment.masked, apiContext };
      console.log(`[模式3][Session] 建立成功 generation=${session.generation} | IP=${assignment.masked} | Cookie=${cookies.length}`);
      return session;
    } catch (error) {
      lastError = error;
      if (assignment?.raw) {
        proxyPool.markBlocked(assignment.raw);
        console.log(`[模式3][Session] 当前代理淘汰/冷却 → 轮询下一个 | ${assignment.masked} | ${error.message}`);
      } else console.log(`[模式3][Session] 获取健康代理失败 | ${error.message}`);
    } finally {
      try { await context?.close(); } catch {}
      try { await browser?.close(); } catch {}
      console.log('[模式3][Session] Chromium已关闭');
    }
  }
  throw lastError || new Error('轮询健康代理后仍无法建立游客 Session');
}

async function refreshVisitorSession(reason = 'Session失效', staleGeneration = null, retireCurrent = false) {
  if (staleGeneration !== null && visitorSession && visitorSession.generation !== staleGeneration) return visitorSession;
  if (!sessionRefreshPromise) {
    sessionRefreshPromise = (async () => {
      const old = visitorSession;
      if (retireCurrent && old?.assignment?.raw) {
        proxyPool.markBlocked(old.assignment.raw);
        console.log(`[模式3][Session] 当前Session代理进入冷却 | IP=${old.proxyLabel}`);
      }
      const fresh = await bootstrapVisitorSession(reason);
      visitorSession = fresh;
      await disposeSession(old);
      return fresh;
    })().finally(() => { sessionRefreshPromise = null; });
  } else console.log('[模式3][Session] 已有换代理任务进行中，本请求等待共用结果');
  return sessionRefreshPromise;
}
async function ensureVisitorSession() { if (visitorSession?.cookie && visitorSession?.apiContext) return visitorSession; return refreshVisitorSession('首次启动：从健康代理池建立Session'); }
function isSessionFailure(result) { if (!result || result.ok) return false; if (result.visitor) return true; return isHttp4xx(result.status); }
async function fetchWithSession(config, uid, session) {
  const url = buildLightProfileApiUrl(config, uid);
  try {
    const response = await session.apiContext.get(url, { timeout: REQUEST_TIMEOUT_MS, failOnStatusCode: false }); const text = await response.text(); const finalUrl = String(response.url() || url); const status = response.status();
    if (finalUrl.includes('visitor.passport.weibo.cn')) return { ok: false, visitor: true, status, message: '跳转visitor.passport', finalUrl, bodySample: compactBody(text) };
    if (status < 200 || status >= 300) return { ok: false, visitor: false, status, message: `HTTP ${status}`, finalUrl, bodySample: compactBody(text) };
    let json = null; try { json = JSON.parse(text); } catch {}
    if (Number(json?.ok ?? 0) !== 1) return { ok: false, visitor: false, status, message: `API ok=${json?.ok ?? '非JSON'}`, finalUrl, bodySample: compactBody(text) };
    return { ok: true, source: 'HTTP_SESSION', status, hasSuperLike: profileTextHasSuperLike(text), finalUrl };
  } catch (error) { return { ok: false, visitor: false, status: null, message: `HTTP异常: ${error.message}` }; }
}
async function checkUser(config, uid, stats) {
  let session = await ensureVisitorSession(); const usedGeneration = session.generation; stats.httpTried++; let result = await fetchWithSession(config, uid, session); if (result.ok) { stats.httpOk++; return result; }
  if (isSessionFailure(result)) {
    stats.sessionFailures++;
    console.log(`[模式3][Session] UID=${uid} | ${result.message} | generation=${usedGeneration} | IP=${session.proxyLabel} → 淘汰当前代理，轮询下一个健康代理+新Cookie`);
    try { session = await refreshVisitorSession(`${result.message}，轮换代理`, usedGeneration, true); stats.httpRetried++; stats.httpTried++; result = await fetchWithSession(config, uid, session); if (result.ok) stats.httpOk++; }
    catch (error) { result = { ok: false, status: null, message: `Session换代理失败: ${error.message}` }; }
  }
  return result;
}
async function mapLimit(items, limit, fn) { const results = new Array(items.length); let cursor = 0; async function worker() { while (true) { const index = cursor++; if (index >= items.length) return; results[index] = await fn(items[index], index); } } await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker)); return results; }
async function runRound(round) {
  const startedAt = Date.now(); const monitors = await getMonitors(); const stats = { users: 0, httpTried: 0, httpOk: 0, httpRetried: 0, sessionFailures: 0, checked: 0, superlike: 0, deleted: 0, failed: 0 };
  console.log(''); console.log(`[Recheck] ===== 模式3 Proxy-Session 第${round}轮开始 =====`); console.log(`[模式3] 只使用健康代理 | HTTP并发=${HTTP_CONCURRENCY} | UID上限=${BATCH_SIZE} | 任意4xx/visitor=轮换代理+Cookie`); logMemory('ROUND_START');
  for (const monitor of monitors) {
    const config = parseMonitorConfig(monitor.url); const users = await getUsers(monitor.id); stats.users += users.length; console.log(`[模式3] Monitor=${monitor.name} | UID=${users.length} | 条件=今天入库+jyz>=70 | 顺序=jyz DESC`); if (!users.length) continue; console.log('[模式3][队列TOP] ' + users.slice(0, 10).map(x => `${x.uid}(jyz=${x.experience_7d ?? '-'})`).join(' | '));
    await ensureVisitorSession();
    const results = await mapLimit(users, HTTP_CONCURRENCY, async (user, index) => { const uid = String(user.uid || '').trim(); const result = await checkUser(config, uid, stats); console.log(`[模式3][HTTP ${index + 1}/${users.length}] UID=${uid} | ${result?.ok ? '成功' : '失败'} | ${result?.ok ? `status=${result.status} | IP=${visitorSession?.proxyLabel || '-'}` : (result?.message || 'unknown')}`); return { uid, result, index }; });
    for (const item of results) {
      const { uid, result, index } = item;
      if (!result?.ok) { stats.failed++; console.log(`[模式3][RESULT ${index + 1}/${users.length}] UID=${uid} | 失败 | ${result?.message || 'unknown'}`); if (!String(result?.message || '').includes('visitor.passport') && !isSessionFailure(result)) await markProfileChecked(monitor.id, uid, 'PROFILE_FAILED'); continue; }
      stats.checked++; await markProfileChecked(monitor.id, uid, result.hasSuperLike ? 'SUPERLIKE' : 'NO_SUPERLIKE');
      if (result.hasSuperLike) { stats.superlike++; const deleted = await graduateUser(monitor.id, uid); stats.deleted += deleted; console.log(`[模式3][RESULT ${index + 1}/${users.length}] UID=${uid} | SuperLike=是 | 删除=${deleted}`); }
      else console.log(`[模式3][RESULT ${index + 1}/${users.length}] UID=${uid} | SuperLike=否 | 保留`);
    }
  }
  const elapsed = Date.now() - startedAt; logMemory('ROUND_END'); console.log(`========== 模式3 Proxy-Session 第${round}轮完成 ==========`); console.log(`UID=${stats.users} | HTTP请求=${stats.httpTried} | HTTP成功=${stats.httpOk} | Session失效=${stats.sessionFailures} | Session重试=${stats.httpRetried} | 检查成功=${stats.checked} | SuperLike=${stats.superlike} | 删除=${stats.deleted} | 失败=${stats.failed}`); console.log(`耗时=${Math.round(elapsed / 1000)}秒 | HTTP成功率=${stats.httpTried ? (stats.httpOk * 100 / stats.httpTried).toFixed(1) : '0.0'}% | Session generation=${visitorSession?.generation ?? 0} | IP=${visitorSession?.proxyLabel || '-'}`); console.log('=============================================='); return elapsed;
}
async function main() {
  if (!process.env.DATABASE_URL) throw new Error('缺少 DATABASE_URL'); createBatchLogger('recheck-superlike', 'mode3'); console.log('[模式3] 新架构：不使用LOCAL；健康代理池轮询 + Cookie/IP绑定Session'); console.log(`[模式3] PG pool max=${pool.options.max} | HTTP并发=${HTTP_CONCURRENCY} | UID上限=${BATCH_SIZE} | 单次建Session最多轮询代理=${SESSION_PROXY_RETRIES} | round=${ROUND_INTERVAL_MS / 1000}s`); let round = 0;
  while (true) { round++; try { const elapsed = await runRound(round); const waitMs = Math.max(0, ROUND_INTERVAL_MS - elapsed); if (waitMs > 0) await sleep(waitMs); } catch (error) { console.error(`[模式3] 第${round}轮异常：`, error); await sleep(Math.min(ROUND_INTERVAL_MS, 30000)); } }
}
main().catch(async error => { console.error('[模式3] 致命异常：', error); try { await disposeSession(visitorSession); } catch {} try { await pool.end(); } catch {} process.exit(1); });