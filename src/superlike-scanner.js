const path = require('path');
const { chromium } = require('playwright');
const { db, initDatabase } = require('./db');

const SCAN_INTERVAL_MS =
  Number(process.env.SUPERLIKE_SCAN_INTERVAL_MS) || 15 * 60 * 1000;
const SCROLL_TIMES =
  Number(process.env.SUPERLIKE_SCROLL_TIMES) || 30;
const SCROLL_DELAY_MS =
  Number(process.env.SUPERLIKE_SCROLL_DELAY_MS) || 1000;
const INITIAL_WAIT_MS =
  Number(process.env.SUPERLIKE_INITIAL_WAIT_MS) || 3000;
const MAX_COMMENTS = 20;

let running = false;

function initSuperLikeTable() {
  initDatabase();
}

function getSuperLikeMonitors() {
  initDatabase();
  return db.prepare(`
    SELECT id,name,url,enabled,monitor_type
    FROM monitors
    WHERE enabled=1 AND monitor_type='superlike'
    ORDER BY id
  `).all();
}

function stripHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim();
}

function getPostId(post) {
  const value = post?.idstr ?? post?.mid ?? post?.id;
  return value == null || value === '' ? '' : String(value);
}

function getUid(post) {
  const value = post?.user?.idstr ?? post?.user?.id ?? post?.uid;
  return value == null || value === '' ? '' : String(value);
}

function getUsername(post) {
  return post?.user?.screen_name ?? post?.user?.name ?? null;
}

function getPostText(post) {
  return stripHtml(post?.text ?? post?.raw_text ?? post?.text_raw ?? '');
}

function getCommentsCount(post) {
  const value = post?.comments_count ?? post?.comment_count;
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getPostCreatedAt(post) {
  const value = post?.created_at ?? post?.createdAt ?? null;
  return value ? String(value) : null;
}

function getPostLink(post) {
  for (const value of [
    post?.url, post?.mblog_url, post?.detail_url, post?.scheme
  ]) {
    if (
      typeof value === 'string' &&
      /^https?:\/\//i.test(value) &&
      value.toLowerCase().includes('weibo')
    ) return value;
  }

  const postId = getPostId(post);
  return postId ? `https://m.weibo.cn/detail/${postId}` : '';
}

function looksLikePost(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (!(obj.idstr ?? obj.mid ?? obj.id) || !obj.user) return false;
  return (
    obj.comments_count !== undefined ||
    obj.comment_count !== undefined ||
    obj.text !== undefined ||
    obj.raw_text !== undefined ||
    obj.text_raw !== undefined ||
    obj.reposts_count !== undefined ||
    obj.attitudes_count !== undefined
  );
}

function findPosts(value, result = [], visited = new Set()) {
  if (!value || typeof value !== 'object' || visited.has(value)) return result;
  visited.add(value);

  if (looksLikePost(value)) result.push(value);

  if (Array.isArray(value)) {
    for (const item of value) findPosts(item, result, visited);
    return result;
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      findPosts(child, result, visited);
    }
  }

  return result;
}

function hasSuperLike(post) {
  if (!post?.user) return false;

  let text = '';
  try {
    text = JSON.stringify(post.user).toLowerCase();
  } catch {
    return false;
  }

  return (
    text.includes('chao_like') ||
    text.includes('chaolike') ||
    text.includes('chao-like') ||
    text.includes('super_like') ||
    text.includes('superlike') ||
    text.includes('超like')
  );
}

function extractIcons(post) {
  const user = post?.user;
  if (!user) return [];

  const result = new Set();
  const visited = new Set();
  const keyPattern = /icon|badge|medal|label|level|pendant|title/i;

  function walk(value, keyName = '') {
    if (value == null) return;

    if (typeof value === 'string') {
      if (!keyPattern.test(keyName)) return;
      const text = value.trim();
      if (!text || text.length > 100 || /^https?:\/\//i.test(text)) return;
      if (/chao[_-]?like|chaolike|super[_-]?like|superlike|超like/i.test(text)) {
        return;
      }
      result.add(text);
      return;
    }

    if (typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value)) {
      for (const item of value) walk(item, keyName);
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      walk(child, key);
    }
  }

  walk(user);
  return Array.from(result);
}

function saveTargetPost(monitorId, post) {
  const postId = getPostId(post);
  if (!postId) return { status: 'skip', reason: 'no_post_id' };

  const commentsCount = getCommentsCount(post);
  if (commentsCount === null) {
    return { status: 'skip', reason: 'unknown_comments' };
  }
  if (commentsCount >= MAX_COMMENTS) {
    return { status: 'skip', reason: 'comments_full' };
  }
  if (hasSuperLike(post)) {
    return { status: 'skip', reason: 'has_superlike' };
  }

  const uid = getUid(post);
  const username = getUsername(post);
  const postLink = getPostLink(post);
  const postText = getPostText(post);
  const postCreatedAt = getPostCreatedAt(post);
  const icons = extractIcons(post);
  const iconSummary = icons.length ? icons.join(' / ') : '无';

  let rawJson = null;
  try {
    rawJson = JSON.stringify(post);
  } catch {}

  const exists = db.prepare(`
    SELECT id FROM superlike_posts
    WHERE monitor_id=? AND post_id=?
    LIMIT 1
  `).get(monitorId, postId);

  if (exists) {
    db.prepare(`
      UPDATE superlike_posts SET
        uid=?,username=?,post_link=?,post_text=?,comments_count=?,
        current_has_superlike=0,icon_summary=?,
        post_created_at=COALESCE(?,post_created_at),
        last_seen_at=CURRENT_TIMESTAMP,raw_json=?
      WHERE id=?
    `).run(
      uid || null, username, postLink || null, postText,
      commentsCount, iconSummary, postCreatedAt, rawJson, exists.id
    );

    return {
      status: 'updated', postId, uid, username,
      postLink, commentsCount, iconSummary
    };
  }

  db.prepare(`
    INSERT INTO superlike_posts(
      monitor_id,post_id,uid,username,post_link,post_text,
      comments_count,current_has_superlike,icon_summary,experience_7d,
      post_created_at,first_seen_at,last_seen_at,raw_json
    )
    VALUES(?,?,?,?,?,?,?,0,?,NULL,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?)
  `).run(
    monitorId, postId, uid || null, username, postLink || null,
    postText, commentsCount, iconSummary, postCreatedAt, rawJson
  );

  return {
    status: 'inserted', postId, uid, username,
    postLink, commentsCount, iconSummary
  };
}

function processResponseJson(monitorId, json, seenThisRun) {
  const stats = {
    found: 0, duplicate: 0, unknownComments: 0,
    commentsFull: 0, hasSuperLike: 0,
    target: 0, inserted: 0, updated: 0
  };

  for (const post of findPosts(json)) {
    const postId = getPostId(post);
    if (!postId) continue;

    if (seenThisRun.has(postId)) {
      stats.duplicate++;
      continue;
    }
    seenThisRun.add(postId);
    stats.found++;

    const commentsCount = getCommentsCount(post);
    if (commentsCount === null) {
      stats.unknownComments++;
      continue;
    }
    if (commentsCount >= MAX_COMMENTS) {
      stats.commentsFull++;
      continue;
    }
    if (hasSuperLike(post)) {
      stats.hasSuperLike++;
      continue;
    }

    stats.target++;
    const result = saveTargetPost(monitorId, post);

    if (result.status === 'inserted') {
      stats.inserted++;
      console.log([
        '[SuperLike][新增]',
        `monitor=${monitorId}`,
        `UID=${result.uid || '-'}`,
        `用户=${result.username || '-'}`,
        `评论=${result.commentsCount}`,
        `Icon=${result.iconSummary || '无'}`,
        result.postLink || '-'
      ].join(' | '));
    } else if (result.status === 'updated') {
      stats.updated++;
    }
  }

  return stats;
}

async function scanOneSuperLikeMonitor(monitor) {
  const topicUrl = String(monitor.url || '').trim();
  if (!topicUrl) {
    console.error(`[SuperLike] Monitor ${monitor.id} URL为空，跳过`);
    return;
  }

  const profileDir = path.join(
    __dirname, '..', 'data', 'superlike-browser-profile'
  );

  const total = {
    found: 0, duplicate: 0, unknownComments: 0,
    commentsFull: 0, hasSuperLike: 0,
    target: 0, inserted: 0, updated: 0
  };

  let browser = null;
  const startedAt = Date.now();

  try {
    console.log('');
    console.log('==============================================');
    console.log(`SuperLike Monitor：${monitor.name}`);
    console.log(`Monitor ID：${monitor.id}`);
    console.log(`URL：${topicUrl}`);
    console.log(`规则：无超Like + 评论 < ${MAX_COMMENTS}`);
    console.log('==============================================');

    browser = await chromium.launchPersistentContext(
      profileDir,
      {
        headless: process.env.SUPERLIKE_HEADLESS === '1',
        viewport: { width: 1280, height: 900 }
      }
    );

    const page = browser.pages()[0] || await browser.newPage();
    const seenThisRun = new Set();
    const pending = new Set();

    page.on('response', response => {
      const task = (async () => {
        try {
          const contentType =
            String(response.headers()['content-type'] || '').toLowerCase();
          if (!contentType.includes('application/json')) return;

          const responseUrl = response.url().toLowerCase();
          if (!responseUrl.includes('weibo')) return;

          let json;
          try {
            json = await response.json();
          } catch {
            return;
          }

          const stats = processResponseJson(
            monitor.id, json, seenThisRun
          );

          for (const key of Object.keys(total)) {
            total[key] += stats[key] || 0;
          }
        } catch (e) {
          console.error('[SuperLike] Response处理失败：', e.message);
        }
      })();

      pending.add(task);
      task.finally(() => pending.delete(task));
    });

    await page.goto(topicUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60 * 1000
    });

    await page.waitForTimeout(INITIAL_WAIT_MS);

    for (let i = 1; i <= SCROLL_TIMES; i++) {
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });
      await page.waitForTimeout(SCROLL_DELAY_MS);

      if (i % 5 === 0) {
        console.log(
          `[SuperLike] ${monitor.name} 滚动 ${i}/${SCROLL_TIMES}`
        );
      }
    }

    await page.waitForTimeout(2000);
    if (pending.size) {
      await Promise.allSettled(Array.from(pending));
    }

    const dbStats = db.prepare(`
      SELECT
        COUNT(*) AS post_count,
        COUNT(DISTINCT uid) AS user_count
      FROM superlike_posts
      WHERE monitor_id=?
        AND current_has_superlike=0
        AND comments_count<?
    `).get(monitor.id, MAX_COMMENTS);

    console.log('');
    console.log(`========== ${monitor.name} 本轮结果 ==========`);
    console.log('扫描微博：', total.found);
    console.log('本轮重复：', total.duplicate);
    console.log('评论数未知：', total.unknownComments);
    console.log('评论>=20：', total.commentsFull);
    console.log('已有超Like：', total.hasSuperLike);
    console.log('符合候选：', total.target);
    console.log('新入库：', total.inserted);
    console.log('已有数据更新：', total.updated);
    console.log('数据库候选帖子：', dbStats?.post_count ?? 0);
    console.log('数据库候选用户：', dbStats?.user_count ?? 0);
    console.log(
      '耗时：',
      `${Math.round((Date.now() - startedAt) / 1000)}秒`
    );
    console.log('==============================================');

  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

async function scanSuperLikePosts() {
  if (running) {
    console.log('[SuperLike] 上一轮尚未结束，本轮跳过。');
    return;
  }

  running = true;
  try {
    initDatabase();

    const monitors = getSuperLikeMonitors();
    if (!monitors.length) {
      console.log('');
      console.log('[SuperLike] 没有启用的 SuperLike Monitor。');
      console.log(
        "请将目标 monitors 记录设置为 monitor_type='superlike' 且 enabled=1"
      );
      return;
    }

    console.log(
      `[SuperLike] 本轮需要扫描 ${monitors.length} 个 Monitor`
    );

    for (const monitor of monitors) {
      try {
        await scanOneSuperLikeMonitor(monitor);
      } catch (e) {
        console.error(
          `[SuperLike] ${monitor.name} 扫描失败：`,
          e
        );
      }
    }
  } finally {
    running = false;
  }
}

async function startSuperLikeBatch() {
  initDatabase();

  console.log('');
  console.log('################################################');
  console.log('# SuperLike Batch');
  console.log(`# 每 ${SCAN_INTERVAL_MS / 60000} 分钟扫描一次`);
  console.log('# URL来源：monitors表');
  console.log("# Monitor条件：enabled=1 + monitor_type='superlike'");
  console.log('# 入库条件：无超Like + 评论 < 20');
  console.log('# Ctrl+C 停止');
  console.log('################################################');

  await scanSuperLikePosts();

  setInterval(async () => {
    console.log('');
    console.log('[SuperLike] 到达下一轮执行时间');
    try {
      await scanSuperLikePosts();
    } catch (e) {
      console.error('[SuperLike] 定时扫描失败：', e);
    }
  }, SCAN_INTERVAL_MS);
}

process.on('SIGINT', () => {
  console.log('');
  console.log('[SuperLike] 收到 Ctrl+C，Batch 停止。');
  process.exit(0);
});

module.exports = {
  initSuperLikeTable,
  getSuperLikeMonitors,
  scanSuperLikePosts,
  scanOneSuperLikeMonitor,
  startSuperLikeBatch,
  hasSuperLike,
  extractIcons,
  findPosts,
  getPostId,
  getUid,
  getUsername,
  getPostText,
  getPostLink,
  getCommentsCount
};

if (require.main === module) {
  startSuperLikeBatch().catch(error => {
    console.error('[SuperLike] Batch启动失败：', error);
    process.exit(1);
  });
}
