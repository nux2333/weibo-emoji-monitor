const { chromium } = require('playwright');
const {
  db, getMonitor, getMonitors, saveComments, saveApiResponse,
  saveDailyStats, updateMonitorStatus, getAllComments,
  getLatestFailedApiResponse
} = require('./db');
const { analyzeComments } = require('./emoji');

const DEFAULT_PAGE_SIZE = 100;
const PAGE_DELAY = 500;
const ERROR_RETRY_DELAY = 3 * 60 * 1000;
const API_TIMEOUT = 60 * 1000;
const runningMonitors = new Set();

function todayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function parseCommentTime(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const n = Number(value);
    if (n > 100000000000) return n;
    if (n > 1000000000) return n * 1000;
  }
  let t = Date.parse(String(value).trim());
  if (!Number.isNaN(t)) return t;
  t = Date.parse(String(value).trim().replace(/-/g,'/'));
  return Number.isNaN(t) ? null : t;
}

function findCommentArrays(value, result=[], depth=0) {
  if (value == null || depth > 20) return result;
  if (Array.isArray(value)) {
    const candidates = value.filter(item => item && typeof item === 'object' &&
      (item.content || item.text || item.comment || item.comment_content) &&
      (item.id !== undefined || item.comment_id !== undefined || item.commentId !== undefined || item.cid !== undefined));
    if (candidates.length) result.push(candidates);
    for (const item of value) findCommentArrays(item,result,depth+1);
    return result;
  }
  if (typeof value === 'object') for (const key of Object.keys(value)) findCommentArrays(value[key],result,depth+1);
  return result;
}

function normalizeComments(data) {
  const map = new Map();
  for (const arr of findCommentArrays(data)) {
    for (const item of arr) {
      const id = item.comment_id ?? item.commentId ?? item.id ?? item.cid;
      const content = item.content ?? item.text ?? item.comment ?? item.comment_content;
      if (id == null || !content) continue;
      const key = String(id);
      if (!map.has(key)) {
        map.set(key, {
          commentId: key,
          content: String(content),
          commentTime: item.created_at ?? item.create_time ?? item.createdAt ?? item.comment_time ?? item.commentTime ?? item.time ?? null
        });
      }
    }
  }
  return [...map.values()];
}

function buildPageUrl(originalUrl,pageNum,pageSize) {
  const u = new URL(originalUrl);
  u.searchParams.set('page_num',String(pageNum));
  u.searchParams.set('page_size',String(pageSize));
  return u.toString();
}
function getApiNextState(data) {
  const v = data?.data?.is_next ?? data?.is_next;
  if (v !== undefined && v !== null) return Number(v) === 1;
  return null;
}
function getLatestCommentTime(monitorId) {
  let latest = null;
  for (const c of getAllComments(monitorId)) {
    const t = parseCommentTime(c.comment_time);
    if (t != null && (latest == null || t > latest)) latest = t;
  }
  return latest;
}
function pageIsHistory(comments, cutoffTime) {
  if (cutoffTime == null) return false;
  const withTime = comments.map(c => parseCommentTime(c.commentTime)).filter(t => t != null);
  return withTime.length > 0 && withTime.every(t => t <= cutoffTime);
}
function filterNewComments(comments, cutoffTime, incremental) {
  if (!incremental || cutoffTime == null) return comments;
  return comments.filter(c => {
    const t = parseCommentTime(c.commentTime);
    return t == null || t > cutoffTime;
  });
}

async function fetchCommentPage(page, originalUrl, monitorId, pageNum, pageSize) {
  const apiUrl = buildPageUrl(originalUrl,pageNum,pageSize);
  console.log(`请求第 ${pageNum} 页：${apiUrl}`);
  try {
    const result = await page.evaluate(async ({url,timeout}) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(),timeout);
      try {
        const response = await fetch(url,{method:'GET',credentials:'include',headers:{Accept:'application/json, text/plain, */*'},signal:controller.signal});
        const text = await response.text();
        let data;
        try { data = JSON.parse(text); }
        catch (e) { return {ok:false,type:'invalid_json',status:response.status,responseText:text,error:`API 返回的不是 JSON：${text.slice(0,1000)}`}; }
        return {ok:true,status:response.status,data};
      } catch (e) {
        return {ok:false,type:e.name==='AbortError'?'timeout':'network',status:null,responseText:null,error:e.message || String(e)};
      } finally { clearTimeout(timer); }
    },{url:apiUrl,timeout:API_TIMEOUT});

    if (result.ok) {
      if (result.status < 200 || result.status >= 300) {
        saveApiResponse({monitorId,pageNum,apiUrl,httpStatus:result.status,responseData:result.data,errorMessage:`HTTP 状态异常：${result.status}`});
        throw new Error(`API HTTP 状态异常：${result.status}`);
      }
      saveApiResponse({monitorId,pageNum,apiUrl,httpStatus:result.status,responseData:result.data,errorMessage:null});
      return result.data;
    }

    let msg = result.error || '未知 API 错误';
    if (result.type === 'timeout') msg = `API 请求超时（${API_TIMEOUT/1000} 秒）`;
    else if (result.type === 'network') msg = `网络请求失败：${msg}`;
    const responseData = result.responseText != null ? {raw_response:result.responseText} : null;
    saveApiResponse({monitorId,pageNum,apiUrl,httpStatus:result.status,responseData,errorMessage:msg});
    throw new Error(msg);
  } catch (error) {
    const message = error.message || String(error);
    const alreadySaved = /^(API 请求超时|网络请求失败：|API HTTP 状态异常：|API 返回的不是 JSON：)/.test(message);
    if (!alreadySaved) {
      saveApiResponse({monitorId,pageNum,apiUrl,httpStatus:null,responseData:null,errorMessage:`Playwright/API 异常：${message}`});
    }
    throw error;
  }
}

async function fetchComments(url,monitorId,incremental=true) {
  const browser = await chromium.launch({headless:true});
  const page = await browser.newPage({viewport:{width:390,height:844},userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'});
  const cutoffTime = incremental ? getLatestCommentTime(monitorId) : null;

  // 如果上一次程序停在错误请求上，重启后从那一页继续，而不是从第 1 页重新跑。
  const failed = incremental ? getLatestFailedApiResponse(monitorId) : null;
  let pageNum = failed ? Number(failed.page_num) : 1;
  if (failed) console.log(`检测到上次失败请求：第 ${pageNum} 页，重启后从该页继续：${failed.api_url}`);

  const allComments = new Map();
  const newComments = new Map();
  try {
    console.log('\n================================');
    console.log(`开始抓取：${url}`);
    console.log(incremental ? '当前模式：按评论时间增量抓取' : '当前模式：首次全量抓取');
    console.log(`DB 抓取开始时最新评论时间：${cutoffTime ? new Date(cutoffTime).toLocaleString() : '无'}`);
    console.log('================================');

    await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForTimeout(2000);

    while (true) {
      let data;
      while (true) {
        try {
          data = await fetchCommentPage(page,url,monitorId,pageNum,DEFAULT_PAGE_SIZE);
          break;
        } catch (error) {
          console.error(`第 ${pageNum} 页请求失败：${error.message}`);
          console.error(`失败 URL：${buildPageUrl(url,pageNum,DEFAULT_PAGE_SIZE)}`);
          console.error(`失败 Response 已保存到 api_responses。3 分钟后重试第 ${pageNum} 页...`);
          await new Promise(r => setTimeout(r,ERROR_RETRY_DELAY));
          try {
            await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
            await page.waitForTimeout(2000);
          } catch (e) { console.error(`重新打开页面失败：${e.message}`); }
        }
      }

      const comments = normalizeComments(data);
      console.log(`第 ${pageNum} 页 API 返回：${comments.length} 条`);
      if (!comments.length) {
        console.log('API 返回 0 条评论，停止抓取。');
        break;
      }
      if (incremental && pageIsHistory(comments,cutoffTime)) {
        console.log(`第 ${pageNum} 页全部属于历史评论，停止继续翻页。`);
        break;
      }

      const pageNew = filterNewComments(comments,cutoffTime,incremental);
      for (const c of comments) {
        const id = String(c.commentId);
        if (!allComments.has(id)) allComments.set(id,c);
      }
      for (const c of pageNew) {
        const id = String(c.commentId);
        if (!newComments.has(id)) newComments.set(id,c);
      }

      if (pageNew.length) {
        console.log(`本页新评论：${pageNew.length} 条，立即保存。`);
        saveComments(monitorId,pageNew);
      } else {
        console.log('本页没有需要新增保存的评论。');
      }
      console.log(`本页历史/已有评论：${comments.length-pageNew.length} 条`);

      const next = getApiNextState(data);
      if (next === false) {
        console.log('API 表示已经没有下一页。');
        break;
      }
      pageNum++;
      if (PAGE_DELAY) await new Promise(r => setTimeout(r,PAGE_DELAY));
    }

    const all = [...allComments.values()];
    const fresh = [...newComments.values()];
    console.log(`========== 抓取完成 ==========`);
    console.log(`本次发现评论：${all.length} 条`);
    console.log(`本次新增评论：${fresh.length} 条`);
    return {allComments:all,newComments:fresh,isIncremental:incremental};
  } finally { await browser.close(); }
}

async function runMonitor(monitorId) {
  if (runningMonitors.has(monitorId)) { console.log(`Monitor ${monitorId} 已经在运行`); return; }
  const monitor = getMonitor(monitorId);
  if (!monitor) throw new Error(`Monitor ${monitorId} 不存在`);
  if (!monitor.enabled) { console.log(`Monitor ${monitorId} 已停用`); return; }
  runningMonitors.add(monitorId);
  try {
    updateMonitorStatus(monitorId,'running');
    const emojis = JSON.parse(monitor.emojis || '[]');
    const texts = JSON.parse(monitor.texts || '[]');
    const firstRun = getAllComments(monitorId).length === 0;
    console.log(`\n========== Monitor ${monitorId} ==========`);
    console.log(`名称：${monitor.name}`);
    console.log(firstRun ? '首次抓取：全量' : '后续抓取：按评论时间增量');
    const result = await fetchComments(monitor.url,monitorId,!firstRun);
    const allDb = getAllComments(monitorId);
    const stats = analyzeComments(allDb.map(x => ({content:x.content})),emojis,texts);
    saveDailyStats({monitorId,statDate:todayString(),...stats});
    updateMonitorStatus(monitorId,'success');
    console.log(`数据库评论总数：${stats.totalComments}，本次新增：${result.newComments.length}`);
    return stats;
  } catch (error) {
    console.error(`Monitor ${monitorId} 抓取失败：`,error);
    updateMonitorStatus(monitorId,'error');
    throw error;
  } finally { runningMonitors.delete(monitorId); }
}

async function runAllMonitors() {
  const monitors = getMonitors(true);
  console.log(`当前共有 ${monitors.length} 个启用监控`);
  for (const m of monitors) {
    try { await runMonitor(m.id); }
    catch (e) { console.error(`Monitor ${m.id} failed:`,e.message); }
  }
}
function getNextSixAM() {
  const now = new Date(); const next = new Date(now); next.setHours(6,0,0,0);
  if (next <= now) next.setDate(next.getDate()+1); return next;
}
function startScheduler() {
  const schedule = () => {
    const next = getNextSixAM();
    const delay = next.getTime()-Date.now();
    console.log(`下一次自动抓取：${next.toLocaleString()}`);
    setTimeout(async () => { try { await runAllMonitors(); } finally { schedule(); } },delay);
  };
  schedule();
}

module.exports = { runMonitor,runAllMonitors,startScheduler,normalizeComments,fetchComments };
