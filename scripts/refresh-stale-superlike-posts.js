'use strict';

const { chromium } = require('playwright');
const { createBatchLogger } = require('../src/batch-logger');
const {
  db,
  initDatabase,
  getSuperLikeMonitors,
  saveSuperLikeUser
} = require('../src/db');
const { parseTopicHomepage } = require('../src/superlike/monitor-scanner');
const { checkUserSuperLikeByProfile } = require('../src/superlike/profile');
const { checkSuperLikeByBrowser } = require('../src/superlike/mode3-profile');
const {
  getPostId,
  getUid,
  getCommentsCount,
  getPostCreatedAt,
  parsePostCreatedAtMs
} = require('../src/superlike/post-utils');
const {
  saveTargetPost,
  deletePostsByUidWithLog
} = require('../src/superlike/post-save');
const {
  acquireScanProxyWaiting,
  SCAN_PROXY_POOL,
  isProxyConnectionError
} = require('../src/superlike/proxy');
const {
  queryExperience7d,
  closeJyzHttpClient
} = require('../src/superlike/jyz-http-client');

createBatchLogger('refresh-stale-superlike-posts');

const LIMIT = Math.max(
  1,
  Number(process.env.SUPERLIKE_STALE_REFRESH_LIMIT) || 300
);
const PROFILE_DELAY_MS = Math.max(
  0,
  Number(process.env.SUPERLIKE_STALE_REFRESH_DELAY_MS) || 200
);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function shanghaiDateParts(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(ms));
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day)
  };
}

function shanghaiDayStartText(offsetDays = 0) {
  const now = shanghaiDateParts();
  const noonUtc = Date.UTC(
    now.year,
    now.month - 1,
    now.day + offsetDays,
    12,
    0,
    0
  );
  const p = shanghaiDateParts(noonUtc);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} 00:00:00`;
}

function fifteenDaysAgoText() {
  const p = shanghaiDateParts(Date.now() - 15 * 24 * 60 * 60 * 1000);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} 00:00:00`;
}

function cleanupOlderThan15Days() {
  const cutoff = fifteenDaysAgoText();
  const rows = db.prepare(`
    SELECT uid
    FROM superlike_posts
    WHERE post_created_at IS NOT NULL
      AND TRIM(post_created_at) <> ''
      AND post_created_at < ?
  `).all(cutoff);

  let deleted = 0;
  for (const row of rows) {
    const uid = String(row?.uid || '').trim();
    if (!uid) continue;
    deleted += deletePostsByUidWithLog(
      uid,
      'POST_CREATED_AT_OLDER_THAN_15_DAYS'
    );
  }

  console.log(
    `[StaleRefresh][启动清理] post_created_at < ${cutoff} | 删除=${deleted}`
  );
}

function getCandidates(monitorId, limit) {
  const cutoff = shanghaiDayStartText(-1);

  return db.prepare(`
    SELECT
      id,
      monitor_id,
      post_id,
      uid,
      username,
      post_created_at,
      experience_7d
    FROM superlike_posts
    WHERE monitor_id = ?
      AND uid IS NOT NULL
      AND TRIM(uid) <> ''
      AND post_created_at IS NOT NULL
      AND TRIM(post_created_at) <> ''
      AND post_created_at < ?
    ORDER BY post_created_at ASC, id ASC
    LIMIT ?
  `).all(
    Number(monitorId),
    cutoff,
    Number(limit)
  );
}

function updateExperience(uid, value) {
  db.prepare(`
    UPDATE superlike_posts
    SET
      experience_7d = ?,
      initial_experience_7d = COALESCE(initial_experience_7d, ?),
      profile_status = CASE
        WHEN profile_status = 'PROFILE_FAILED' THEN 'NO_SUPERLIKE'
        ELSE profile_status
      END
    WHERE uid = ?
  `).run(
    Number(value),
    Number(value),
    String(uid)
  );
}

function pickLatestPost(profilePosts, expectedUid) {
  if (!Array.isArray(profilePosts)) return null;

  return profilePosts
    .map(post => ({
      post,
      postId: getPostId(post),
      uid: String(getUid(post) || '').trim(),
      createdAtMs: parsePostCreatedAtMs(post),
      createdAt: getPostCreatedAt(post),
      comments: getCommentsCount(post)
    }))
    .filter(item =>
      item.postId
      && item.uid === String(expectedUid)
      && Number.isFinite(Number(item.createdAtMs))
    )
    .sort(
      (a, b) => Number(b.createdAtMs) - Number(a.createdAtMs)
    )[0] || null;
}

async function openBrowser() {
  const assignment = await acquireScanProxyWaiting();
  const proxy = assignment?.proxy || null;

  console.log(
    proxy
      ? `[StaleRefresh] 使用健康代理：${assignment.masked}`
      : '[StaleRefresh] 当前使用本地IP'
  );

  const browser = await chromium.launch({
    channel: 'chromium',
    headless: true,
    ignoreHTTPSErrors: true,
    ...(proxy ? { proxy } : {})
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 }
  });

  return { browser, context, assignment };
}

function shouldRotateForResult(result) {
  const status = Number(result?.status);
  const text = String(result?.message || result?.error || '');

  return (
    (Number.isFinite(status) && status >= 400 && status < 500)
    || /ERR_HTTP_RESPONSE_CODE_FAILURE/i.test(text)
    || isProxyConnectionError(new Error(text))
  );
}

async function rotateBrowserState(state, reason) {
  console.log(
    `[StaleRefresh][代理失败] ${reason || '-'} | 淘汰当前代理并重建浏览器`
  );

  if (state?.assignment?.raw) {
    try {
      SCAN_PROXY_POOL.remove(state.assignment.raw);
    } catch {}
  }

  try { await state?.context?.close(); } catch {}
  try { await state?.browser?.close(); } catch {}

  return openBrowser();
}

async function replaceWithLatest(row, monitor, latest, experience7d) {
  const uid = String(row.uid);
  const oldPostId = String(row.post_id || '');
  const latestPostId = String(latest.postId || '');

  if (latestPostId === oldPostId) {
    updateExperience(uid, experience7d);
    console.log(
      `[StaleRefresh][已是最新] UID=${uid} | Post=${latestPostId} | 经验值=${experience7d}`
    );
    return 'same';
  }

  if (latest.comments === null || Number(latest.comments) >= 21) {
    updateExperience(uid, experience7d);
    console.log(
      `[StaleRefresh][最新帖不可入库] UID=${uid} | new=${latestPostId} | 评论=${latest.comments ?? 'unknown'} | 保留旧帖`
    );
    return 'kept';
  }

  db.prepare(`
    DELETE FROM superlike_posts
    WHERE id = ?
      AND uid = ?
      AND post_id = ?
  `).run(
    Number(row.id),
    uid,
    oldPostId
  );

  const saveResult = saveTargetPost(
    Number(monitor.id),
    latest.post,
    'NO_SUPERLIKE'
  );

  if (!saveResult || saveResult.status === 'skip') {
    throw new Error(
      `最新帖保存失败 UID=${uid} old=${oldPostId} new=${latestPostId} reason=${saveResult?.reason || 'unknown'}`
    );
  }

  updateExperience(uid, experience7d);

  console.log(
    `[StaleRefresh][替换完成] UID=${uid} | ${oldPostId} -> ${latestPostId} | 发帖=${latest.createdAt || '-'} | 评论=${latest.comments} | 经验值=${experience7d}`
  );

  return 'replaced';
}

async function runMonitor(monitor) {
  const config = parseTopicHomepage(monitor.url);
  const topicHash = config?.topicHash;

  if (!topicHash) {
    throw new Error(`Monitor ${monitor.id} 无法解析 topicHash`);
  }

  const rows = getCandidates(monitor.id, LIMIT);
  const cutoff = shanghaiDayStartText(-1);

  console.log('');
  console.log('==============================================');
  console.log(
    `[StaleRefresh] Monitor=${monitor.name} | 本轮=${rows.length} | limit=${LIMIT}`
  );
  console.log(
    `[StaleRefresh] 只查 post_created_at < ${cutoff}（今天/昨天不查）`
  );
  console.log('[StaleRefresh] 顺序=post_created_at ASC（最旧优先）');
  console.log('==============================================');

  const summary = {
    checked: 0,
    superLike: 0,
    replaced: 0,
    same: 0,
    kept: 0,
    profileFailed: 0,
    jyzFailed: 0,
    noLatest: 0
  };

  if (!rows.length) return summary;

  let state = await openBrowser();

  try {
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const uid = String(row.uid);

      console.log('');
      console.log(
        `[StaleRefresh ${index + 1}/${rows.length}] UID=${uid} | Post=${row.post_id} | 发帖=${row.post_created_at} | 当前经验=${row.experience_7d ?? '-'}`
      );

      let allbadge;
      try {
        allbadge = await checkSuperLikeByBrowser(
          state.context,
          config,
          uid,
          null,
          'StaleRefresh'
        );
      } catch (error) {
        if (shouldRotateForResult({ message: error?.message || String(error) })) {
          state = await rotateBrowserState(
            state,
            error?.message || String(error)
          );
          index--;
          continue;
        }
        throw error;
      }

      if (!allbadge?.ok) {
        const failureText = String(
          allbadge?.message || allbadge?.error || ''
        );

        if (shouldRotateForResult(allbadge)) {
          state = await rotateBrowserState(state, failureText);
          index--;
          continue;
        }

        summary.profileFailed++;
        console.log(
          `[StaleRefresh][超Like检查失败] UID=${uid} | ${failureText || '-'} | 保留旧帖`
        );
        await sleep(PROFILE_DELAY_MS);
        continue;
      }

      summary.checked++;

      if (allbadge.hasSuperLike) {
        saveSuperLikeUser(Number(monitor.id), uid);
        const deleted = deletePostsByUidWithLog(
          uid,
          'SUPERLIKE_STALE_REFRESH'
        );
        summary.superLike++;
        console.log(
          `[StaleRefresh][已超Like] UID=${uid} | 删除=${deleted}`
        );
        await sleep(PROFILE_DELAY_MS);
        continue;
      }

      const jyz = await queryExperience7d(topicHash, uid);
      if (!jyz.ok) {
        summary.jyzFailed++;
        console.log(
          `[StaleRefresh][经验值失败] UID=${uid} | ${jyz.message || '-'} | 保留旧帖`
        );
        await sleep(PROFILE_DELAY_MS);
        continue;
      }

      updateExperience(uid, jyz.experience7d);
      console.log(
        `[StaleRefresh][经验值] UID=${uid} | ${row.experience_7d ?? '-'} -> ${jyz.experience7d} | source=${jyz.source || 'direct-http'}`
      );

      const profile = await checkUserSuperLikeByProfile(
        state.context,
        config,
        uid,
        state.context
      );

      if (!profile?.ok) {
        const failureText = String(
          profile?.message || profile?.error || ''
        );

        if (shouldRotateForResult(profile)) {
          state = await rotateBrowserState(state, failureText);
          index--;
          continue;
        }

        summary.profileFailed++;
        console.log(
          `[StaleRefresh][主页失败] UID=${uid} | ${failureText || '-'} | 已更新经验值，旧帖保留`
        );
        await sleep(PROFILE_DELAY_MS);
        continue;
      }

      if (profile.hasSuperLike) {
        saveSuperLikeUser(Number(monitor.id), uid);
        const deleted = deletePostsByUidWithLog(
          uid,
          'SUPERLIKE_STALE_REFRESH_PROFILE'
        );
        summary.superLike++;
        console.log(
          `[StaleRefresh][主页确认超Like] UID=${uid} | 删除=${deleted}`
        );
        await sleep(PROFILE_DELAY_MS);
        continue;
      }

      const latest = pickLatestPost(
        profile.profilePosts,
        uid
      );

      if (!latest) {
        summary.noLatest++;
        console.log(
          `[StaleRefresh][无最新帖] UID=${uid} | 主页第一页没有该UID可解析帖子 | 保留旧帖`
        );
        await sleep(PROFILE_DELAY_MS);
        continue;
      }

      const result = await replaceWithLatest(
        row,
        monitor,
        latest,
        jyz.experience7d
      );

      if (result === 'replaced') summary.replaced++;
      else if (result === 'same') summary.same++;
      else summary.kept++;

      await sleep(PROFILE_DELAY_MS);
    }
  } finally {
    try { await state.context.close(); } catch {}
    try { await state.browser.close(); } catch {}
  }

  return summary;
}

(async () => {
  initDatabase();

  console.log('');
  console.log('##############################################');
  console.log('# Stale SuperLike Post Refresh');
  console.log('# 1. 启动删除 post_created_at 15天以前');
  console.log('# 2. 今天/昨天不处理；前天及更早按发帖时间正序');
  console.log('# 3. 超Like => 删除');
  console.log('# 4. 非超Like => 直接HTTP查经验值 => 主页最新帖替换旧帖');
  console.log('# 5. 不依赖127.0.0.1:3011/jyz');
  console.log('##############################################');

  cleanupOlderThan15Days();

  const monitors = getSuperLikeMonitors();
  const total = {
    checked: 0,
    superLike: 0,
    replaced: 0,
    same: 0,
    kept: 0,
    profileFailed: 0,
    jyzFailed: 0,
    noLatest: 0
  };

  try {
    for (const monitor of monitors) {
      const summary = await runMonitor(monitor);
      for (const key of Object.keys(total)) {
        total[key] += Number(summary[key] || 0);
      }
    }
  } finally {
    await closeJyzHttpClient().catch(() => {});
  }

  console.log('');
  console.log('==============================================');
  console.log('[StaleRefresh] 本轮完成');
  console.log(
    `[StaleRefresh] 检查=${total.checked} | 超Like删除=${total.superLike} | 换新帖=${total.replaced} | 已是最新=${total.same} | 保留=${total.kept} | Profile失败=${total.profileFailed} | 经验值失败=${total.jyzFailed} | 无最新帖=${total.noLatest}`
  );
  console.log('==============================================');
})().catch(async error => {
  await closeJyzHttpClient().catch(() => {});
  console.error('[StaleRefresh][FATAL]', error?.stack || error);
  process.exitCode = 1;
});
