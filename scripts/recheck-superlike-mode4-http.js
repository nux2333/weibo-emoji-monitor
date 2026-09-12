'use strict';

const path = require('path');
const { chromium, request } = require('playwright');
const {
  db,
  initDatabase,
  addSuperLikePoolExitCount
} = require('../src/db');

const LIST_DAY_INTERVAL_MS =
  Number(process.env.SUPERLIKE_LIST_DAY_INTERVAL_MS)
  || 20 * 60 * 1000;

const LIST_NIGHT_INTERVAL_MS =
  Number(process.env.SUPERLIKE_LIST_NIGHT_INTERVAL_MS)
  || 5 * 60 * 1000;

const LIST_FIRST_RUN_MAX_PAGES =
  Number(process.env.SUPERLIKE_LIST_FIRST_RUN_MAX_PAGES)
  || 50;

const LIST_BOUNDARY_SAFETY_MAX_PAGES =
  Number(process.env.SUPERLIKE_LIST_BOUNDARY_SAFETY_MAX_PAGES)
  || 1000;

const LIST_REQUEST_DELAY_MS =
  Number(process.env.SUPERLIKE_LIST_REQUEST_DELAY_MS)
  || 250;

const REQUEST_TIMEOUT_MS =
  Number(process.env.SUPERLIKE_MODE4_HTTP_TIMEOUT_MS)
  || 15000;

const PROFILE_DIR =
  path.resolve(
    process.env.SUPERLIKE_MODE4_USER_DATA_DIR
    || path.join(
      __dirname,
      '..',
      'data',
      'superlike-browser-profile-scan'
    )
  );

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getChinaDate() {
  const parts = new Intl.DateTimeFormat(
    'en-CA',
    {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }
  ).formatToParts(new Date());

  const map = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }

  return `${map.year}-${map.month}-${map.day}`;
}

function getChinaDateTime() {
  const parts = new Intl.DateTimeFormat(
    'en-CA',
    {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }
  ).formatToParts(new Date());

  const map = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }

  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}

function getChinaHour() {
  return Number(
    new Intl.DateTimeFormat(
      'en-US',
      {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        hour12: false
      }
    ).format(new Date())
  );
}

function getMode4IntervalMs() {
  const hour = getChinaHour();
  return hour >= 19 && hour <= 23
    ? LIST_NIGHT_INTERVAL_MS
    : LIST_DAY_INTERVAL_MS;
}

function parseTopicHomepage(topicUrl) {
  const url = new URL(String(topicUrl || '').trim());
  const match = url.pathname.match(/\/p\/(100808[a-f0-9]{32})/i);
  if (!match) {
    throw new Error(`无法从 Monitor URL 解析超话 page_id：${topicUrl}`);
  }

  const containerId = match[1];
  const topicHash = containerId.replace(/^100808/i, '');

  return {
    containerId,
    topicHash,
    chaoLikeListContainerId:
      `231140${topicHash}_-_chaolikenew`
  };
}

function getSuperLikeMonitors() {
  initDatabase();
  return db.prepare(`
    SELECT id, name, url
    FROM monitors
    WHERE enabled = 1
      AND monitor_type = 'superlike'
    ORDER BY id
  `).all();
}

function getListState(monitorId) {
  const row = db.prepare(`
    SELECT last_uid, scan_date, last_total, updated_at
    FROM superlike_list_state
    WHERE monitor_id = ?
  `).get(monitorId);

  if (!row) return null;

  return {
    lastUid: row.last_uid ? String(row.last_uid) : null,
    scanDate: row.scan_date ? String(row.scan_date) : null,
    lastTotal: Number.isFinite(Number(row.last_total))
      ? Number(row.last_total)
      : null,
    updatedAt: row.updated_at || null
  };
}

function saveListState(monitorId, lastUid, scanDate, lastTotal) {
  if (!lastUid) return;

  db.prepare(`
    INSERT INTO superlike_list_state(
      monitor_id,
      last_uid,
      scan_date,
      last_total,
      updated_at
    )
    VALUES(?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(monitor_id) DO UPDATE SET
      last_uid = excluded.last_uid,
      scan_date = excluded.scan_date,
      last_total = excluded.last_total,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    monitorId,
    String(lastUid),
    scanDate || null,
    Number.isFinite(Number(lastTotal)) ? Number(lastTotal) : null
  );
}

function cleanupSuperLikeUsersForToday(monitorId, scanDate) {
  const result = db.prepare(`
    DELETE FROM superlike_users
    WHERE monitor_id = ?
      AND scan_date <> ?
  `).run(monitorId, scanDate);

  return Number(result.changes || 0);
}

function upsertSuperLikeUsers(monitorId, uidList, scanDate, rankStart) {
  if (!Array.isArray(uidList) || uidList.length === 0) return 0;

  const chinaNow = getChinaDateTime();
  const stmt = db.prepare(`
    INSERT INTO superlike_users(
      monitor_id,
      uid,
      scan_date,
      inserted_at,
      last_seen_at,
      first_seen_rank,
      last_seen_rank
    )
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(uid) DO UPDATE SET
      monitor_id = excluded.monitor_id,
      scan_date = excluded.scan_date,
      last_seen_at = excluded.last_seen_at,
      last_seen_rank = excluded.last_seen_rank
  `);

  let saved = 0;
  db.exec('BEGIN');

  try {
    for (let i = 0; i < uidList.length; i++) {
      const uid = String(uidList[i] || '').trim();
      if (!uid) continue;

      const rank = Number(rankStart) + i;
      stmt.run(
        monitorId,
        uid,
        scanDate,
        chinaNow,
        chinaNow,
        rank,
        rank
      );
      saved++;
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }

  return saved;
}

function deletePostsByUidSet(monitorId, uidSet) {
  const uids = Array.from(uidSet || [])
    .map(uid => String(uid || '').trim())
    .filter(Boolean);

  if (uids.length === 0) return 0;

  const chunkSize = 500;
  let deleted = 0;
  let deletedUsers = 0;

  for (let i = 0; i < uids.length; i += chunkSize) {
    const chunk = uids.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    const row = db.prepare(`
      SELECT COUNT(DISTINCT uid) AS user_count
      FROM superlike_posts
      WHERE monitor_id = ?
        AND uid IN (${placeholders})
    `).get(monitorId, ...chunk);
    deletedUsers += Number(row?.user_count || 0);
  }

  db.exec('BEGIN');
  try {
    for (let i = 0; i < uids.length; i += chunkSize) {
      const chunk = uids.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const result = db.prepare(`
        DELETE FROM superlike_posts
        WHERE monitor_id = ?
          AND uid IN (${placeholders})
      `).run(monitorId, ...chunk);
      deleted += Number(result.changes || 0);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }

  if (deletedUsers > 0) {
    addSuperLikePoolExitCount(deletedUsers);
  }

  console.log(
    `[模式4][今日毕业] 候选UID=${deletedUsers} | 今日累计已增加`
  );

  return deleted;
}

function buildListUrl(config, sinceId = null) {
  const url = new URL('https://m.weibo.cn/api/container/getIndex');
  url.searchParams.set('containerid', config.chaoLikeListContainerId);
  url.searchParams.set('title', '超LIKE榜');
  if (sinceId) url.searchParams.set('since_id', String(sinceId));
  return url.toString();
}

function extractUids(json) {
  const result = [];
  const cards = Array.isArray(json?.data?.cards)
    ? json.data.cards
    : [];

  for (const card of cards) {
    const groups = Array.isArray(card?.card_group)
      ? card.card_group
      : [];

    for (const item of groups) {
      const uid = item?.user?.idstr ?? item?.user?.id;
      if (uid !== undefined && uid !== null && String(uid).trim()) {
        result.push(String(uid));
      }
    }
  }

  return result;
}

function extractNextSinceId(json) {
  const value = json?.data?.cardlistInfo?.since_id ?? null;
  return value === null || value === undefined || value === ''
    ? null
    : String(value);
}

function extractTotal(json) {
  const visited = new Set();

  function parseText(value) {
    const text = String(value || '');
    const wan = text.match(/超\s*LIKE\s*\(\s*([\d.]+)\s*万\s*人?\s*\)/i);
    if (wan) return Math.round(Number(wan[1]) * 10000);

    const plain = text.match(/超\s*LIKE\s*\(\s*([\d,]+)\s*人?\s*\)/i);
    if (plain) return Number(plain[1].replace(/,/g, ''));
    return null;
  }

  function walk(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return parseText(value);
    if (typeof value !== 'object' || visited.has(value)) return null;
    visited.add(value);

    if (typeof value.desc === 'string') {
      const parsed = parseText(value.desc);
      if (parsed !== null) return parsed;
    }

    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      const result = walk(child);
      if (result !== null) return result;
    }
    return null;
  }

  return walk(json);
}

function cookiesToHeader(cookies) {
  return (cookies || [])
    .filter(item => item?.name)
    .map(item => `${item.name}=${item.value}`)
    .join('; ');
}

async function createHttpSession() {
  console.log(
    `[模式4][Session] 启动 Persistent Chromium 读取登录Cookie | Profile=${PROFILE_DIR}`
  );

  const context = await chromium.launchPersistentContext(
    PROFILE_DIR,
    {
      headless: false,
      viewport: { width: 1280, height: 900 }
    }
  );

  let cookies = [];
  let userAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

  try {
    const page = context.pages()[0] || await context.newPage();

    try {
      await page.goto(
        'https://m.weibo.cn/',
        {
          waitUntil: 'domcontentloaded',
          timeout: REQUEST_TIMEOUT_MS
        }
      );
      await page.waitForTimeout(1200);
    } catch (error) {
      console.log(
        `[模式4][Session] 打开 m.weibo.cn 异常，继续读取已有Cookie | ${error.message}`
      );
    }

    cookies = await context.cookies([
      'https://m.weibo.cn/',
      'https://weibo.com/'
    ]);

    userAgent = await page.evaluate(() => navigator.userAgent)
      .catch(() => userAgent);
  } finally {
    await context.close();
  }

  const cookieHeader = cookiesToHeader(cookies);
  console.log(
    `[模式4][Session] Chromium已关闭 | Cookie=${cookies.length} | names=${cookies.map(item => item.name).join(',') || '-'}`
  );

  if (!cookieHeader) {
    throw new Error('Persistent Profile 未读取到登录Cookie');
  }

  const api = await request.newContext({
    userAgent,
    extraHTTPHeaders: {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Referer: 'https://m.weibo.cn/',
      Cookie: cookieHeader
    }
  });

  return { api, cookieNames: cookies.map(item => item.name) };
}

function isSessionFailure(result) {
  if (!result) return true;
  if ([401, 403, 418, 432].includes(Number(result.status))) return true;
  if (/visitor\.passport\.weibo\.cn|passport\.weibo\.cn|passport\.weibo\.com|登录/i.test(
    `${result.finalUrl || ''} ${result.bodyPreview || ''} ${result.message || ''}`
  )) return true;
  return false;
}

async function fetchListPage(session, config, sinceId = null) {
  const url = buildListUrl(config, sinceId);

  try {
    const response = await session.api.get(
      url,
      {
        timeout: REQUEST_TIMEOUT_MS,
        failOnStatusCode: false
      }
    );

    const status = response.status();
    const finalUrl = response.url();
    const body = await response.text();
    const bodyPreview = String(body || '').replace(/\s+/g, ' ').slice(0, 300);

    let json = null;
    try { json = JSON.parse(body); } catch {}

    const ok =
      status >= 200
      && status < 300
      && Number(json?.ok ?? 0) === 1
      && !/visitor\.passport\.weibo\.cn|passport\.weibo\.cn|passport\.weibo\.com/i.test(finalUrl);

    return {
      ok,
      status,
      finalUrl,
      bodyPreview,
      json,
      message: ok
        ? ''
        : `chaolikenew HTTP ${status} / ok=${json?.ok ?? '非JSON'}`
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      finalUrl: url,
      bodyPreview: '',
      json: null,
      message: error.message
    };
  }
}

async function runRound(sessionRef) {
  const monitors = getSuperLikeMonitors();

  for (const monitor of monitors) {
    const config = parseTopicHomepage(monitor.url);
    const state = getListState(monitor.id);
    const previousLastUid = state?.lastUid || null;
    const today = getChinaDate();
    const sameDay = state?.scanDate === today;
    const firstRun = !sameDay;

    let maxPages = firstRun
      ? LIST_FIRST_RUN_MAX_PAGES
      : LIST_BOUNDARY_SAFETY_MAX_PAGES;

    let sinceId = null;
    let pageNumber = 0;
    let currentTotal = null;
    let newestUid = null;
    let reachedBoundary = false;
    let completed = false;
    let cleanupDone = false;
    const uidSet = new Set();

    console.log('');
    console.log(`[模式4] Monitor=${monitor.name}`);
    console.log(
      firstRun
        ? `[模式4] 当天首次运行：最多抓 ${LIST_FIRST_RUN_MAX_PAGES} 页`
        : `[模式4] 上次状态：日期=${state?.scanDate || '-'} | 总人数=${state?.lastTotal ?? '-'} | 边界UID=${previousLastUid || '-'}`
    );

    while (pageNumber < maxPages) {
      let result = await fetchListPage(sessionRef.current, config, sinceId);

      if (!result.ok && isSessionFailure(result)) {
        console.log(
          `[模式4][Session] 第${pageNumber + 1}页登录态失效，刷新Cookie后重试 | status=${result.status} | ${result.message}`
        );

        try { await sessionRef.current.api.dispose(); } catch {}
        sessionRef.current = await createHttpSession();
        result = await fetchListPage(sessionRef.current, config, sinceId);
      }

      if (!result.ok) {
        console.log(
          `[模式4] 第${pageNumber + 1}页失败 | ${result.message} | status=${result.status ?? '-'} | url=${result.finalUrl || '-'} | body=${result.bodyPreview || '-'}`
        );
        console.log('[模式4] 本轮未完整结束，不更新扫描边界。');
        break;
      }

      pageNumber++;
      const uids = extractUids(result.json);
      const nextSinceId = extractNextSinceId(result.json);

      if (pageNumber === 1) {
        currentTotal = extractTotal(result.json);

        if (!cleanupDone) {
          const cleaned = cleanupSuperLikeUsersForToday(monitor.id, today);
          cleanupDone = true;
          console.log(`[模式4] 清理非当天超LIKE用户数据：${cleaned} 条`);
        }

        if (uids.length > 0) newestUid = uids[0];
      }

      console.log(
        `[模式4][HTTP] 第${pageNumber}页 | UID=${uids.length} | 请求since_id=${sinceId || '-'} | 返回since_id=${nextSinceId || '-'}`
      );

      const rankStart = (pageNumber - 1) * 20 + 1;
      const savedUsers = upsertSuperLikeUsers(
        monitor.id,
        uids,
        today,
        rankStart
      );

      console.log(
        `[模式4] 第${pageNumber}页保存当天超LIKE UID=${savedUsers} | 排名约=${rankStart}-${rankStart + Math.max(0, uids.length - 1)}`
      );

      for (const uid of uids) {
        if (!firstRun && previousLastUid && uid === previousLastUid) {
          reachedBoundary = true;
          console.log(`[模式4] 命中上次边界 UID=${uid}`);
          break;
        }
        uidSet.add(uid);
      }

      if (reachedBoundary) {
        completed = true;
        break;
      }

      if (!nextSinceId || nextSinceId === sinceId) {
        console.log('[模式4] 没有下一页 since_id，正常结束。');
        completed = true;
        break;
      }

      sinceId = nextSinceId;
      await sleep(LIST_REQUEST_DELAY_MS);
    }

    if (pageNumber >= maxPages) {
      completed = firstRun;
      console.log(
        firstRun
          ? `[模式4] 当天首次运行已成功抓满 ${maxPages} 页。`
          : `[模式4] 未命中上次边界，但已达到安全上限 ${maxPages} 页，停止以防无限翻页。`
      );
    }

    const deleted = deletePostsByUidSet(monitor.id, uidSet);

    console.log(
      `[模式4] Monitor=${monitor.name} | 扫描页=${pageNumber} | UID=${uidSet.size} | 删除DB记录=${deleted} | 完整结束=${completed ? '是' : '否'} | 命中旧边界=${reachedBoundary ? '是' : '否'}`
    );

    if (completed && newestUid) {
      saveListState(monitor.id, newestUid, today, currentTotal);
      console.log(
        `[模式4] 已更新状态：日期=${today} | 总人数=${currentTotal ?? '-'} | 边界UID=${newestUid}`
      );
    } else {
      console.log('[模式4] 本轮 incomplete，保留旧边界不变。');
    }
  }
}

async function main() {
  initDatabase();

  console.log('');
  console.log('########################################');
  console.log('# SuperLike Recheck - 模式4 HTTP UID模式');
  console.log('# Persistent Chromium仅用于读取/刷新登录Cookie，读取后立即关闭');
  console.log('# 正式分页：LOCAL + 登录Cookie + HTTP');
  console.log(`# 当天首次最多 ${LIST_FIRST_RUN_MAX_PAGES} 页`);
  console.log(`# 后续安全上限 ${LIST_BOUNDARY_SAFETY_MAX_PAGES} 页`);
  console.log('########################################');

  const sessionRef = {
    current: await createHttpSession()
  };

  let round = 0;

  try {
    while (true) {
      round++;
      const intervalMs = getMode4IntervalMs();
      const startedAt = Date.now();

      console.log('');
      console.log(
        `[Recheck] ===== 模式4 HTTP 第${round}轮开始 | 当前间隔=${intervalMs / 60000}分钟 =====`
      );

      try {
        await runRound(sessionRef);
      } catch (error) {
        console.error(`[Recheck] 模式4 HTTP 第${round}轮异常：`, error);
      }

      const elapsed = Date.now() - startedAt;
      const waitMs = Math.max(0, intervalMs - elapsed);

      if (waitMs > 0) {
        console.log(
          `[Recheck] 模式4 HTTP 第${round}轮结束，${Math.round(waitMs / 60000)}分钟后进入下一轮；Chromium已关闭，仅保留HTTP Session。`
        );
        await sleep(waitMs);
      }
    }
  } finally {
    try { await sessionRef.current?.api?.dispose(); } catch {}
  }
}

main().catch(error => {
  console.error('[模式4 HTTP] 启动失败：', error);
  process.exitCode = 1;
});
