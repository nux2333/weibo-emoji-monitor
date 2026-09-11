const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const { chromium, request } = require('playwright');
const { db, initDatabase } = require('../../src/db');

const ROOT = path.join(__dirname, '..', '..');
const ACCOUNT = String(process.env.COMMENT_ACCOUNT || 'default')
  .trim()
  .replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
const LEGACY_PROFILE_DIR = path.join(ROOT, 'data', 'comment-assistant-profile');
const PROFILE_ROOT = path.join(ROOT, 'data', 'comment-assistant-profiles');
const DEFAULT_ACCOUNT_PROFILE = path.join(PROFILE_ROOT, ACCOUNT);
const PROFILE_DIR = process.env.COMMENT_ASSISTANT_PROFILE
  ? path.resolve(process.env.COMMENT_ASSISTANT_PROFILE)
  : (
      ACCOUNT === 'default'
      && fs.existsSync(LEGACY_PROFILE_DIR)
      && !fs.existsSync(DEFAULT_ACCOUNT_PROFILE)
        ? LEGACY_PROFILE_DIR
        : DEFAULT_ACCOUNT_PROFILE
    );
const GOOD_PROXY_FILE = process.env.WEIBO_GOOD_PROXY_FILE
  ? path.resolve(process.env.WEIBO_GOOD_PROXY_FILE)
  : path.join(ROOT, 'data', 'weibo-good-proxies.txt');
const MIN_EXPERIENCE = Number(process.env.COMMENT_MIN_EXPERIENCE || 70);
const LIMIT = Number(process.env.COMMENT_TARGET_LIMIT || 20);
const MAX_COMMENTS = Number(process.env.COMMENT_MAX_EXISTING_COMMENTS || 19);
const DEFAULT_COMMENT = process.env.COMMENT_TEXT || '法国人是世界上最严肃的人类因为他们见面就会互相说一句绷住';
const COMMENT_FP = process.env.COMMENT_FP || '';

fs.mkdirSync(PROFILE_DIR, { recursive: true });

function formatShanghaiDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function getShanghaiToday() {
  return formatShanghaiDate(new Date());
}

function normalizeProxy(rawValue) {
  const raw = String(rawValue || '').split('#')[0].trim();
  if (!raw) return null;
  return /^(?:https?|socks5):\/\//i.test(raw) ? raw : `http://${raw}`;
}
function readGoodProxyPool() {
  try {
    if (!fs.existsSync(GOOD_PROXY_FILE)) return [];
    return Array.from(new Set(fs.readFileSync(GOOD_PROXY_FILE, 'utf8').split(/\r?\n/).map(normalizeProxy).filter(Boolean)));
  } catch (error) { console.warn(`[代理池] 读取失败：${error.message}`); return []; }
}
function toPlaywrightProxy(rawValue) {
  const normalized = normalizeProxy(rawValue); if (!normalized) return null;
  try { const p = new URL(normalized); const proxy = { server: `${p.protocol}//${p.hostname}${p.port ? ':' + p.port : ''}` }; if (p.username) proxy.username = decodeURIComponent(p.username); if (p.password) proxy.password = decodeURIComponent(p.password); return proxy; } catch { return { server: normalized }; }
}
function maskProxy(rawValue) { try { const p = new URL(rawValue); return `${p.protocol}//${p.hostname}${p.port ? ':' + p.port : ''}`; } catch { return String(rawValue || '').replace(/\/\/[^@]+@/, '//***@'); } }
function pickRandomHealthyProxy() { const items = readGoodProxyPool(); return items.length ? items[Math.floor(Math.random() * items.length)] : null; }
async function createReadOnlyProxyContext(proxy) { if (!proxy) return null; return request.newContext({ proxy: toPlaywrightProxy(proxy), ignoreHTTPSErrors: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36', extraHTTPHeaders: { Accept: 'text/html,application/xhtml+xml,application/json,text/plain,*/*' } }); }
async function readPostViaProxy(apiContext, url) { if (!apiContext) return null; try { const r = await apiContext.get(url, { timeout: 10000, failOnStatusCode: false }); return { status: r.status(), ok: r.ok() }; } catch (error) { return { status: null, ok: false, error: error.message }; } }

function getTargets() {
  const shanghaiToday = getShanghaiToday();
  const rows = db.prepare(`
    SELECT post_id, uid, username, post_link, post_text, experience_7d,
           comments_count, initial_comments_count, post_created_at, first_seen_at
    FROM superlike_posts
    WHERE COALESCE(current_has_superlike, 0) = 0
      AND experience_7d IS NOT NULL
      AND experience_7d >= ?
      AND COALESCE(comments_count, 0) <= ?
      AND post_link IS NOT NULL
      AND TRIM(post_link) <> ''
      AND post_created_at IS NOT NULL
    ORDER BY experience_7d DESC, first_seen_at DESC
  `).all(MIN_EXPERIENCE, MAX_COMMENTS);

  const todayRows = rows.filter(row => formatShanghaiDate(row.post_created_at) === shanghaiToday);
  todayRows.sort((a, b) => {
    const experienceDiff = Number(b.experience_7d || 0) - Number(a.experience_7d || 0);
    if (experienceDiff !== 0) return experienceDiff;
    const postDiff = new Date(b.post_created_at).getTime() - new Date(a.post_created_at).getTime();
    if (Number.isFinite(postDiff) && postDiff !== 0) return postDiff;
    return new Date(b.first_seen_at || 0).getTime() - new Date(a.first_seen_at || 0).getTime();
  });

  return todayRows.slice(0, LIMIT);
}

async function launchBrowser(headless) {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: { width: 1280, height: 900 }
  });
}

async function hasWeiboLogin(context) {
  const cookies = await context.cookies('https://weibo.com');
  return cookies.some(cookie => cookie.name === 'SUB' && cookie.value);
}

async function checkWeiboSession(context) {
  if (!(await hasWeiboLogin(context))) return false;
  try {
    const page = context.pages()[0] || await context.newPage();
    if (!/^https:\/\/weibo\.com\//i.test(page.url())) {
      await page.goto('https://weibo.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }

    const result = await page.evaluate(async () => {
      try {
        const response = await fetch('/ajax/config/getConfig', {
          method: 'GET',
          credentials: 'include',
          headers: {
            Accept: 'application/json, text/plain, */*',
            'X-Requested-With': 'XMLHttpRequest'
          }
        });
        const text = await response.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        return {
          ok: response.ok,
          status: response.status,
          url: response.url,
          json,
          text: text.slice(0, 500)
        };
      } catch (error) {
        return { ok: false, status: 0, url: '', json: null, text: '', error: error.message };
      }
    });

    if (result.error) {
      console.warn(`[登录] 页面登录态检查失败：${result.error}`);
      return false;
    }

    const json = result.json || {};
    const code = Number(json.ok ?? json.code ?? json.error_code);
    const redirectUrl = String(json.url || json.redirect || '');
    const combinedUrl = `${result.url || ''} ${redirectUrl}`;
    if (code === -100 || /newlogin|passport\.weibo|\/login/i.test(combinedUrl)) return false;

    const config = json.data || json;
    if (config.login === false) return false;
    if (config.login === true) return true;
    if (config.uid !== undefined && String(config.uid || '').trim()) return true;

    return result.ok && result.status === 200;
  } catch (error) {
    console.warn(`[登录] 页面登录态检查异常：${error.message}`);
    return false;
  }
}

async function interactiveLogin(oldContext, clearCookies, reason) {
  if (oldContext) await oldContext.close().catch(() => {});

  console.log(reason || '[登录] 正在打开 Chrome，请手动登录微博。');
  let context = await launchBrowser(false);
  if (clearCookies) await context.clearCookies().catch(() => {});

  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://weibo.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

  while (true) {
    if (await hasWeiboLogin(context)) {
      await page.waitForTimeout(1200);
      if (await checkWeiboSession(context)) break;
    }
    await page.waitForTimeout(1000);
  }

  console.log('[登录] 登录成功，已保存登录信息；关闭可见 Chrome，切回后台运行。');
  await context.close();
  context = await launchBrowser(true);

  if (!(await checkWeiboSession(context))) {
    await context.close();
    throw new Error('登录信息保存后仍未通过服务端校验，请重新运行后再次登录');
  }

  console.log(`[登录] ${ACCOUNT} 登录信息确认完成。`);
  return context;
}

async function ensureLoggedIn() {
  console.log(`[账号] ${ACCOUNT} | Profile=${PROFILE_DIR}`);
  let context = await launchBrowser(true);

  if (await hasWeiboLogin(context)) {
    if (await checkWeiboSession(context)) {
      console.log('[登录] 已检测到有效登录信息，Chrome 后台运行。');
      return context;
    }
    return interactiveLogin(
      context,
      true,
      '[登录] 检测到旧登录信息已失效，正在打开 Chrome，请重新登录微博。'
    );
  }

  return interactiveLogin(
    context,
    false,
    '[登录] 当前账号没有登录信息，正在打开 Chrome，请手动登录微博。'
  );
}

async function getCurrentCommentCountFromApi(page, postId, uid) {
  return page.evaluate(async ({ postId, uid }) => {
    const url = new URL('/ajax/statuses/buildComments', location.origin);
    Object.entries({ is_reload:'1', id:String(postId), is_show_bulletin:'3', is_mix:'0', count:'10', uid:String(uid || ''), fetch_level:'0', locale:'zh-CN' }).forEach(([k,v]) => url.searchParams.set(k,v));
    try {
      const response = await fetch(url.toString(), { method:'GET', credentials:'include', headers:{ Accept:'application/json, text/plain, */*', 'X-Requested-With':'XMLHttpRequest' } });
      const text = await response.text(); let json = null; try { json = JSON.parse(text); } catch {}
      const total = Number(json?.total_number);
      return { ok: response.ok && json?.ok === 1 && Number.isFinite(total), status: response.status, totalNumber: Number.isFinite(total) ? total : null, apiOk: json?.ok ?? null, message: json?.message || json?.msg || '', raw: text.slice(0,300) };
    } catch (error) { return { ok:false, status:null, totalNumber:null, apiOk:null, message:error.message, raw:'' }; }
  }, { postId, uid });
}
async function getCurrentCommentCountFromDom(page) {
  return page.evaluate(() => {
    const parseCount = raw => { const text = String(raw || '').replace(/,/g,'').trim(); if (!text) return null; for (const p of [/评论\s*[（(]?\s*(\d+)\s*[）)]?/i,/共\s*(\d+)\s*条?评论/i,/(\d+)\s*条?评论/i]) { const m=text.match(p); if(m) return Number(m[1]); } return null; };
    for (const selector of ['[aria-label*="评论"]','[title*="评论"]','button','a','[role="button"]']) for (const node of document.querySelectorAll(selector)) for (const candidate of [node.getAttribute?.('aria-label'),node.getAttribute?.('title'),node.textContent]) { const count=parseCount(candidate); if(Number.isFinite(count)) return count; }
    return parseCount(document.body ? document.body.innerText : '');
  }).catch(() => null);
}
async function getCurrentCommentCount(page, postId, uid) { const apiResult=await getCurrentCommentCountFromApi(page,postId,uid); if(apiResult?.ok && Number.isFinite(apiResult.totalNumber)) return {count:apiResult.totalNumber,source:'buildComments',apiResult}; const domCount=await getCurrentCommentCountFromDom(page); return {count:Number.isFinite(domCount)?domCount:null,source:Number.isFinite(domCount)?'DOM回退':null,apiResult}; }

async function getCsrfToken(page, context) {
  const cookies=await context.cookies('https://weibo.com');
  for(const name of ['XSRF-TOKEN','XSRF_TOKEN','csrf','csrf_token','CSRF-TOKEN','_csrf']) { const found=cookies.find(c=>c.name===name&&c.value); if(found) return {token:decodeURIComponent(found.value),source:`cookie:${name}`}; }
  return page.evaluate(() => { for(const selector of ['meta[name="csrf-token"]','meta[name="csrf_token"]','meta[name="xsrf-token"]','meta[name="x-xsrf-token"]']) { const value=document.querySelector(selector)?.getAttribute('content'); if(value) return {token:value,source:`meta:${selector}`}; } const globals=[['window.$CONFIG.csrf',window.$CONFIG&&window.$CONFIG.csrf],['window.$CONFIG.csrf_token',window.$CONFIG&&window.$CONFIG.csrf_token],['window.__INITIAL_STATE__.csrf',window.__INITIAL_STATE__&&window.__INITIAL_STATE__.csrf],['window.__INITIAL_STATE__.csrfToken',window.__INITIAL_STATE__&&window.__INITIAL_STATE__.csrfToken]]; for(const [source,value] of globals) if(value) return {token:String(value),source}; return null; }).catch(()=>null);
}
async function sendComment(page, context, postId, commentText) {
  const csrf=await getCsrfToken(page,context); if(!csrf?.token) return {ok:false,status:0,json:null,text:'CSRF token not found',csrfSource:null};
  const result=await page.evaluate(async ({postId,commentText,fp,csrfToken}) => { const form=new URLSearchParams(); Object.entries({id:String(postId),comment:commentText,pic_id:'',is_repost:'0',comment_ori:'0',is_comment:'0'}).forEach(([k,v])=>form.set(k,v)); if(fp) form.set('fp',fp); const response=await fetch('/ajax/comments/create',{method:'POST',credentials:'include',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','X-Requested-With':'XMLHttpRequest','X-XSRF-TOKEN':csrfToken,'X-CSRF-TOKEN':csrfToken,Accept:'application/json, text/plain, */*'},body:form.toString()}); const text=await response.text(); let json=null; try{json=JSON.parse(text);}catch{} return {ok:response.ok,status:response.status,json,text}; },{postId,commentText,fp:COMMENT_FP,csrfToken:csrf.token}); return {...result,csrfSource:csrf.source};
}
function getBusinessCode(result) {
  const body = result?.json || {};
  if (body.ok !== undefined) return body.ok;
  if (body.code !== undefined) return body.code;
  if (body.error_code !== undefined) return body.error_code;
  return null;
}
function isCommentSuccess(result) {
  if (!result?.ok) return false;
  const body = result.json;
  if (!body || typeof body !== 'object') return false;
  if (body.ok !== undefined) return Number(body.ok) === 1;
  if (body.code !== undefined) return Number(body.code) === 0;
  if (body.error_code !== undefined) return Number(body.error_code) === 0;
  return false;
}
function isLoginExpiredResult(result) {
  const body = result?.json || {};
  const code = Number(body.ok ?? body.code ?? body.error_code);
  const redirectUrl = String(body.url || body.redirect || '');
  return code === -100 || /newlogin|passport\.weibo|\/login/i.test(redirectUrl);
}
function summarizeResult(result) {
  if (!result) return '没有返回结果';
  const body = result.json || {};
  const code = getBusinessCode(result);
  const message = body.msg || body.message || body.error || '';
  return [
    `HTTP ${result.status}`,
    code !== null ? `code=${code}` : '',
    message ? `msg=${message}` : '',
    result.csrfSource ? `csrf=${result.csrfSource}` : ''
  ].filter(Boolean).join(' | ');
}

async function main() {
  initDatabase();

  let context = await ensureLoggedIn();
  let readOnlyProxyContext = null;
  let rl = null;

  try {
    const targets = getTargets();
    if (!targets.length) {
      console.log(`没有符合条件的当天帖子：experience_7d >= ${MIN_EXPERIENCE}, comments_count <= ${MAX_COMMENTS}`);
      return;
    }

    console.log(`当天候选帖子 ${targets.length} 条，按经验值从高到低。`);
    console.log('每条评论发送前都会要求你确认。');
    console.log(`默认评论：${DEFAULT_COMMENT}`);
    if (!COMMENT_FP) console.log('COMMENT_FP 未设置：先尝试不传 fp；如果微博返回参数错误，再设置抓包里的 fp。');

    const selectedProxy = pickRandomHealthyProxy();
    if (selectedProxy) {
      console.log(`[只读代理] 健康池=${GOOD_PROXY_FILE}`);
      console.log(`[只读代理] 本轮固定使用：${maskProxy(selectedProxy)}`);
      try { readOnlyProxyContext = await createReadOnlyProxyContext(selectedProxy); }
      catch (error) { console.warn(`[只读代理] 创建失败：${error.message}`); }
    } else {
      console.log(`[只读代理] 未找到健康代理：${GOOD_PROXY_FILE}`);
    }

    let page = context.pages()[0] || await context.newPage();
    rl = readline.createInterface({ input, output });

    for (let i = 0; i < targets.length; i += 1) {
      const row = targets[i];
      console.log('\n==============================================');
      console.log(`[${i + 1}/${targets.length}] 经验值=${row.experience_7d} | 初始评论=${row.initial_comments_count ?? '-'}`);
      console.log(`UID=${row.uid || '-'} | ${row.username || '-'}`);
      console.log(`Post=${row.post_id}`);
      console.log(`Link=${row.post_link}`);
      if (row.post_text) console.log(`文案=${String(row.post_text).replace(/\s+/g, ' ').slice(0, 160)}`);

      if (readOnlyProxyContext) {
        const pr = await readPostViaProxy(readOnlyProxyContext, row.post_link);
        if (pr?.ok) console.log(`[只读代理] GET ${pr.status} OK`);
        else if (pr?.status) console.log(`[只读代理] GET HTTP ${pr.status}`);
        else if (pr?.error) console.log(`[只读代理] GET失败：${pr.error}`);
      }

      await page.goto(row.post_link, { waitUntil:'domcontentloaded', timeout:20000 }).catch(error => console.warn(`打开失败：${error.message}`));
      await page.waitForTimeout(1500);
      const current = await getCurrentCommentCount(page, row.post_id, row.uid);
      if (Number.isFinite(current.count)) console.log(`[评论] 初始=${row.initial_comments_count ?? '-'} | 当前=${current.count} | 来源=${current.source}`);
      else {
        console.log(`[评论] 初始=${row.initial_comments_count ?? '-'} | 当前=未获取到`);
        if (current.apiResult) console.log(`[buildComments] HTTP=${current.apiResult.status ?? '-'} | ok=${current.apiResult.apiOk ?? '-'} | ${current.apiResult.message || current.apiResult.raw || ''}`);
      }

      const csrf = await getCsrfToken(page, context);
      console.log(csrf?.token ? `[CSRF] 已找到：${csrf.source}` : '[CSRF] 未找到 token');
      const answer = (await rl.question(`发送评论“${DEFAULT_COMMENT}”？输入 y 发送；s 跳过；q 退出：`)).trim().toLowerCase();
      if (answer === 'q') break;
      if (answer !== 'y') continue;

      try {
        const result = await sendComment(page, context, row.post_id, DEFAULT_COMMENT);
        const success = isCommentSuccess(result);
        console.log(`[评论结果] ${success ? '✅ 成功' : '❌ 失败'} | ${summarizeResult(result)}`);
        if (!success) {
          const raw = result?.text ? String(result.text).slice(0, 1000) : '';
          if (raw) console.log(`[微博返回] ${raw}`);
          else if (result?.json) console.log(`[微博返回] ${JSON.stringify(result.json)}`);
          else console.log('[微博返回] 无响应内容');
        }

        if (isLoginExpiredResult(result)) {
          console.log('[登录] 微博返回登录失效（ok=-100/newlogin），停止继续发送并要求重新登录。');
          context = await interactiveLogin(
            context,
            true,
            '[登录] 正在打开 Chrome，请重新登录微博。'
          );
          page = context.pages()[0] || await context.newPage();
          console.log('[登录] 已恢复登录。当前帖子不会自动发送，将重新显示并再次等待你的确认。');
          i -= 1;
          continue;
        }
      } catch (error) {
        console.error(`[评论失败] ${error.message}`);
      }
    }
  } finally {
    if (rl) rl.close();
    if (readOnlyProxyContext) await readOnlyProxyContext.dispose().catch(() => {});
    await context.close().catch(() => {});
  }
}
main().catch(error => { console.error('[comment-assistant] 异常：', error); process.exitCode = 1; });