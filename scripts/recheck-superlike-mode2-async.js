const path = require('path');
const { Pool } = require('pg');
const { chromium, request } = require('playwright');
const { createBatchLogger } = require('../src/batch-logger');
const { ProxyPool } = require('../src/proxy-pool');
const { shouldRotateProxy } = require('../src/proxy-http-policy');
const { buildLightProfileApiUrl, profileTextHasSuperLike } = require('../src/superlike/mode3-profile');

const ROUND_INTERVAL_MS = Number(process.env.SUPERLIKE_MODE2_ROUND_INTERVAL_MS) || 15 * 1000;
const REQUEST_TIMEOUT_MS = Number(process.env.SUPERLIKE_LIGHT_REQUEST_TIMEOUT_MS) || 10000;
const SESSION_BOOTSTRAP_TIMEOUT_MS = Number(process.env.SUPERLIKE_MODE2_SESSION_BOOTSTRAP_TIMEOUT_MS) || 15000;
const SESSION_PROXY_RETRIES = Math.max(1, Math.min(20, Number(process.env.SUPERLIKE_MODE2_SESSION_PROXY_RETRIES) || 10));
const HTTP_CONCURRENCY = Math.max(1, Math.min(20, Number(process.env.SUPERLIKE_MODE2_HTTP_CONCURRENCY) || 8));
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Math.max(2, Number(process.env.PG_MODE2_POOL_MAX) || 6), idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000, allowExitOnIdle: false });
const proxyPool = new ProxyPool({
  filePath: process.env.WEIBO_GOOD_PROXY_FILE || path.join(__dirname, '..', 'data', 'weibo-good-proxies.txt'),
  cooldownMs: Number(process.env.SUPERLIKE_MODE2_PROXY_COOLDOWN_MS) || 5 * 60 * 1000,
  name: 'mode2-session'
});

let visitorSession = null;
let sessionRefreshPromise = null;
let sessionGeneration = 0;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function cookieHeader(cookies) { return cookies.map(c => `${c.name}=${c.value}`).join('; '); }
function compact(text) { return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 180); }
function memoryMB(v) { return Math.round(Number(v || 0) / 1024 / 1024); }
function logMemory(label) { const m = process.memoryUsage(); console.log(`[模式2][Memory][${label}] RSS=${memoryMB(m.rss)}MB | Heap=${memoryMB(m.heapUsed)}/${memoryMB(m.heapTotal)}MB | PG total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}`); }
function parseMonitorConfig(url) { const match = String(url || '').match(/100808([a-f0-9]{32})/i); if (!match) throw new Error(`无法从超话URL解析 page_id: ${url}`); return { pageId: `100808${match[1]}`, profileContainerId: `231140${match[1]}_-_profile_inpage` }; }

async function acquireProxy() { const a = await proxyPool.acquire(); if (!a?.configured || !a.raw || !a.proxy) throw new Error('健康代理池当前没有可用代理'); return a; }
async function disposeSession(session) { try { await session?.apiContext?.dispose(); } catch {} }

async function bootstrapVisitorSession(reason = '建立Session') {
  let lastError = null;
  for (let attempt = 1; attempt <= SESSION_PROXY_RETRIES; attempt++) {
    let assignment = null, browser = null, context = null;
    try {
      assignment = await acquireProxy();
      console.log(`[模式2][Session] ${reason} → 健康代理 ${assignment.masked} | ${attempt}/${SESSION_PROXY_RETRIES}`);
      browser = await chromium.launch({ headless: true, proxy: assignment.proxy });
      context = await browser.newContext({ userAgent: USER_AGENT, locale: 'zh-CN' });
      const page = await context.newPage();
      const response = await page.goto('https://m.weibo.cn/', { waitUntil: 'domcontentloaded', timeout: SESSION_BOOTSTRAP_TIMEOUT_MS });
      const firstStatus = response?.status();
      console.log(`[模式2][Session] 首页 status=${firstStatus ?? '-'} | final=${page.url()} | IP=${assignment.masked}`);
      if (shouldRotateProxy({ status: firstStatus })) throw Object.assign(new Error(`Chromium首页 HTTP ${firstStatus}`), { blocked: true });
      await page.waitForTimeout(2500);
      if (page.url().includes('visitor.passport.weibo.cn')) {
        await page.waitForTimeout(2000);
        const second = await page.goto('https://m.weibo.cn/', { waitUntil: 'domcontentloaded', timeout: SESSION_BOOTSTRAP_TIMEOUT_MS });
        const secondStatus = second?.status();
        if (shouldRotateProxy({ status: secondStatus })) throw Object.assign(new Error(`Chromium游客初始化 HTTP ${secondStatus}`), { blocked: true });
        await page.waitForTimeout(1500);
      }
      const cookies = await context.cookies(['https://m.weibo.cn/', 'https://weibo.cn/', 'https://weibo.com/']);
      const cookie = cookieHeader(cookies);
      if (!cookie) throw new Error('Chromium 未取得游客 Cookie');
      const userAgent = await page.evaluate(() => navigator.userAgent);
      const apiContext = await request.newContext({ userAgent, proxy: assignment.proxy, extraHTTPHeaders: { Accept: 'application/json,text/plain,*/*', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', Referer: 'https://weibo.com/', Cookie: cookie } });
      const session = { generation: ++sessionGeneration, assignment, proxyLabel: assignment.masked, cookieNames: cookies.map(c => c.name), apiContext };
      console.log(`[模式2][Session] 建立成功 generation=${session.generation} | IP=${session.proxyLabel} | Cookie=${cookies.length}`);
      return session;
    } catch (error) {
      lastError = error;
      if (assignment?.raw) { proxyPool.markBlocked(assignment.raw); console.log(`[模式2][Session] 当前代理淘汰/冷却 → 下一个 | ${assignment.masked} | ${error.message}`); }
    } finally {
      try { await context?.close(); } catch {}
      try { await browser?.close(); } catch {}
      console.log('[模式2][Session] Chromium已关闭');
    }
  }
  throw lastError || new Error('轮询健康代理后仍无法建立游客Session');
}

async function refreshSession(reason, staleGeneration = null, retireCurrent = false) {
  if (staleGeneration !== null && visitorSession && visitorSession.generation !== staleGeneration) return visitorSession;
  if (!sessionRefreshPromise) {
    sessionRefreshPromise = (async () => {
      const old = visitorSession;
      if (retireCurrent && old?.assignment?.raw) { proxyPool.markBlocked(old.assignment.raw); console.log(`[模式2][Session] 当前Session代理进入冷却 | IP=${old.proxyLabel}`); }
      const fresh = await bootstrapVisitorSession(reason);
      visitorSession = fresh;
      await disposeSession(old);
      return fresh;
    })().finally(() => { sessionRefreshPromise = null; });
  } else console.log('[模式2][Session] 已有换代理任务进行中，本请求等待共用结果');
  return sessionRefreshPromise;
}
async function ensureSession() { return visitorSession?.apiContext ? visitorSession : refreshSession('首次启动：从健康代理池建立Session'); }
function isSessionFailure(result) {
  if (!result || result.ok) return false;
  if (result.visitor) return true;
  return shouldRotateProxy({ status: result.status, message: result.message });
}

function getCommentExperienceBonus(count) { count = Math.max(0, Number(count) || 0); if (count >= 20) return 10; if (count >= 15) return 6; if (count >= 10) return 3; if (count >= 5) return 1; return 0; }
function getDeleteThreshold(post) {
  const initialExperience = Number(post.experience_7d);
  const initialComments = Math.max(0, Number(post.initial_comments_count ?? post.comments_count ?? 0) || 0);
  if (!Number.isFinite(initialExperience)) return 21;
  const initialBonus = getCommentExperienceBonus(initialComments);
  for (const milestone of [5, 10, 15, 20]) {
    if (milestone <= initialComments) continue;
    if (initialExperience + getCommentExperienceBonus(milestone) - initialBonus >= 80) return milestone + 1;
  }
  return 21;
}
function getNextMinutes(count) { count = Number(count) || 0; if (count >= 18) return 0.25; if (count >= 15) return 0.5; if (count >= 10) return 1; return 5; }

async function getCandidates() {
  const r = await pool.query(`SELECT p.id,p.monitor_id,p.post_id,p.uid,p.username,p.post_link,p.comments_count,p.experience_7d,p.initial_comments_count,p.comment_last_checked_at,p.comment_next_check_at,m.url AS monitor_url FROM superlike_posts p JOIN monitors m ON m.id=p.monitor_id WHERE p.post_id IS NOT NULL AND p.post_id<>'' AND CAST(p.inserted_at AS date) = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date AND p.experience_7d > 70 AND p.comments_count < 21 AND (p.comment_next_check_at IS NULL OR CAST(p.comment_next_check_at AS timestamp) <= CURRENT_TIMESTAMP) AND NOT EXISTS(SELECT 1 FROM superlike_users su WHERE su.uid=p.uid) AND NOT EXISTS(SELECT 1 FROM superlike_daily_excluded_users deu WHERE deu.monitor_id=p.monitor_id AND deu.uid=p.uid AND deu.exclude_date=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::text) ORDER BY CASE WHEN p.experience_7d>=79 THEN 5 WHEN p.experience_7d>=77 THEN 10 WHEN p.experience_7d>=74 THEN 15 ELSE 20 END ASC, p.experience_7d DESC NULLS LAST, p.comments_count DESC, CASE WHEN p.comment_last_checked_at IS NULL THEN 0 ELSE 1 END, CAST(p.comment_last_checked_at AS timestamp) ASC NULLS FIRST, p.id DESC`);
  return r.rows;
}

async function requestComments(post, session) {
  const url = new URL('https://weibo.com/ajax/statuses/buildComments');
  url.searchParams.set('is_reload','1'); url.searchParams.set('id',String(post.post_id)); url.searchParams.set('is_show_bulletin','3'); url.searchParams.set('is_mix','0'); url.searchParams.set('count','10'); url.searchParams.set('uid',String(post.uid)); url.searchParams.set('fetch_level','0'); url.searchParams.set('locale','zh-CN');
  try {
    const response = await session.apiContext.get(url.toString(), { timeout: REQUEST_TIMEOUT_MS, failOnStatusCode: false });
    const text = await response.text(); const status = response.status(); const finalUrl = response.url();
    if (String(finalUrl).includes('visitor.passport.weibo.cn')) return { ok:false, visitor:true, status, message:'buildComments 跳转visitor.passport' };
    if (status < 200 || status >= 300) return { ok:false, status, message:`buildComments HTTP ${status}`, sample:compact(text) };
    let json; try { json=JSON.parse(text); } catch { return { ok:false,status,message:'buildComments 非JSON',sample:compact(text) }; }
    const value = json?.total_number ?? json?.data?.total_number;
    if (!Number.isFinite(Number(value))) return { ok:false,status,message:'buildComments 没有 total_number',sample:compact(text) };
    return { ok:true,status,commentsCount:Number(value) };
  } catch(error) { return { ok:false,status:null,message:`buildComments异常: ${error.message}` }; }
}

async function requestProfile(post, session) {
  const config = parseMonitorConfig(post.monitor_url); const url = buildLightProfileApiUrl(config, String(post.uid));
  try {
    const response = await session.apiContext.get(url,{timeout:REQUEST_TIMEOUT_MS,failOnStatusCode:false}); const text=await response.text(); const status=response.status();
    if (String(response.url()).includes('visitor.passport.weibo.cn')) return {ok:false,visitor:true,status,message:'profile_allbadge 跳转visitor.passport'};
    if(status<200||status>=300) return {ok:false,status,message:`profile_allbadge HTTP ${status}`};
    let json; try{json=JSON.parse(text);}catch{return {ok:false,status,message:'profile_allbadge 非JSON'};}
    if(Number(json?.ok??0)!==1) return {ok:false,status,message:`profile_allbadge API ok=${json?.ok??'?'}`};
    return {ok:true,status,hasSuperLike:profileTextHasSuperLike(text)};
  } catch(error){return {ok:false,status:null,message:`profile_allbadge异常: ${error.message}`};}
}

async function withSessionRetry(label, fn) {
  let session=await ensureSession(); const generation=session.generation; let result=await fn(session);
  if(isSessionFailure(result)) {
    console.log(`[模式2][Session] ${label} | ${result.message} | generation=${generation} | IP=${session.proxyLabel} → 共通策略命中，淘汰代理并换IP+Cookie`);
    session=await refreshSession(`${result.message}，统一策略轮换代理`,generation,true);
    result=await fn(session);
  }
  return result;
}

async function schedule(post, count) { const minutes=getNextMinutes(count); await pool.query(`UPDATE superlike_posts SET comments_count=$1,last_seen_at=CURRENT_TIMESTAMP,comment_last_checked_at=CURRENT_TIMESTAMP,comment_next_check_at=CURRENT_TIMESTAMP + ($2::double precision * interval '1 minute') WHERE monitor_id=$3 AND post_id=$4`,[count,minutes,post.monitor_id,post.post_id]); return minutes; }
async function graduate(post, reason) {
  const client=await pool.connect();
  try { await client.query('BEGIN'); await client.query(`INSERT INTO superlike_users(monitor_id,uid,scan_date) VALUES($1,$2,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::text) ON CONFLICT(uid) DO NOTHING`,[post.monitor_id,post.uid]); await client.query(`INSERT INTO superlike_daily_excluded_users(monitor_id,uid,exclude_date,reason) VALUES($1,$2,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::text,$3) ON CONFLICT(monitor_id,uid,exclude_date) DO UPDATE SET reason=EXCLUDED.reason`,[post.monitor_id,post.uid,reason]); const d=await client.query(`DELETE FROM superlike_posts WHERE monitor_id=$1 AND uid=$2 RETURNING id`,[post.monitor_id,post.uid]); if(d.rowCount>0){ await client.query(`INSERT INTO superlike_pool_exit_events(monitor_id,uid,exit_date,reason,exited_at) VALUES($1,$2,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::text,$3,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`,[post.monitor_id,post.uid,reason]); await client.query(`INSERT INTO superlike_pool_exit_daily(exit_date,user_count,updated_at) VALUES((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::text,1,CURRENT_TIMESTAMP) ON CONFLICT(exit_date) DO UPDATE SET user_count=superlike_pool_exit_daily.user_count+1,updated_at=CURRENT_TIMESTAMP`); } await client.query('COMMIT'); return d.rowCount; }
  catch(e){try{await client.query('ROLLBACK');}catch{} throw e;} finally{client.release();}
}

async function mapLimit(items,limit,fn){const out=new Array(items.length);let cursor=0;async function worker(){while(true){const i=cursor++;if(i>=items.length)return;out[i]=await fn(items[i],i);}}await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return out;}

async function runRound(round){
  const started=Date.now(); const posts=await getCandidates(); console.log(`\n[模式2] ===== Proxy-Session HTTP 第${round}轮 | 到期帖子=${posts.length} | 条件=inserted_at今天+jyz>70 =====`); logMemory('ROUND_START'); if(!posts.length)return Date.now()-started;
  await ensureSession();
  const results=await mapLimit(posts,HTTP_CONCURRENCY,async(post,index)=>{
    const comments=await withSessionRetry(`UID=${post.uid} Post=${post.post_id}`,s=>requestComments(post,s));
    if(!comments.ok){console.log(`[模式2][${index+1}/${posts.length}] UID=${post.uid} | Post=${post.post_id} | 评论失败 | ${comments.message}`);return;}
    const threshold=getDeleteThreshold(post); let verify=null;
    if(comments.commentsCount>=threshold){ verify=await withSessionRetry(`UID=${post.uid} allbadge`,s=>requestProfile(post,s)); }
    if(comments.commentsCount>=threshold && verify?.ok && verify.hasSuperLike){ const reason=`SUPERLIKE_MODE2_CONFIRM_${threshold}`; const deleted=await graduate(post,reason); console.log(`[模式2][${index+1}/${posts.length}] UID=${post.uid} | 最新评论=${comments.commentsCount} | 初始评论=${post.initial_comments_count??'-'} | jyz=${post.experience_7d??'-'} | 超LIKE=YES | 删除UID候选=${deleted}`); return; }
    const next=await schedule(post,comments.commentsCount); console.log(`[模式2][${index+1}/${posts.length}] UID=${post.uid} | 最新评论=${comments.commentsCount} | 初始评论=${post.initial_comments_count??'-'} | jyz=${post.experience_7d??'-'}${comments.commentsCount>=threshold?` | 超LIKE=${verify?.ok?(verify.hasSuperLike?'YES':'NO'):'FAILED'}`:' | 超LIKE=NO'} | 保留 | 下次≈${next}分钟`);
  });
  void results; const elapsed=Date.now()-started; logMemory('ROUND_END'); console.log(`[模式2] 第${round}轮完成 | 耗时=${Math.round(elapsed/1000)}秒 | Session generation=${visitorSession?.generation??0} | IP=${visitorSession?.proxyLabel||'-'}`); return elapsed;
}

async function main(){
  if(!process.env.DATABASE_URL)throw new Error('缺少 DATABASE_URL');
  createBatchLogger('recheck-superlike','mode2');
  console.log('[模式2] 统一恢复策略：健康代理 → Chromium取Cookie → 同代理HTTP；4xx/5xx、网络错误、Session/Context/Browser关闭、Playwright timeout、visitor 都自动轮换代理+Session');
  console.log(`[模式2] 查询范围=inserted_at今天 + experience_7d>70 | HTTP并发=${HTTP_CONCURRENCY} | 代理重试=${SESSION_PROXY_RETRIES} | round=${ROUND_INTERVAL_MS/1000}s | 动态阈值=6/11/16/21 + allbadge确认`);
  let round=0;
  while(true){round++;try{const elapsed=await runRound(round);await sleep(Math.max(0,ROUND_INTERVAL_MS-elapsed));}catch(e){console.error(`[模式2] 第${round}轮异常：`,e);await sleep(Math.min(ROUND_INTERVAL_MS,15000));}}
}
main().catch(async e=>{console.error('[模式2] 致命异常：',e);try{await disposeSession(visitorSession);}catch{}try{await pool.end();}catch{}process.exit(1);});