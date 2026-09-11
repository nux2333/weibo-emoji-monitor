const path = require('path');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const { chromium } = require('playwright');
const { db, initDatabase } = require('../../src/db');

const ROOT = path.join(__dirname, '..', '..');
const PROFILE_DIR = process.env.COMMENT_ASSISTANT_PROFILE
  ? path.resolve(process.env.COMMENT_ASSISTANT_PROFILE)
  : path.join(ROOT, 'data', 'comment-assistant-profile');

const MIN_EXPERIENCE = Number(process.env.COMMENT_MIN_EXPERIENCE || 70);
const LIMIT = Number(process.env.COMMENT_TARGET_LIMIT || 20);
const MAX_COMMENTS = Number(process.env.COMMENT_MAX_EXISTING_COMMENTS || 19);

function getTargets() {
  return db.prepare(`
    SELECT
      post_id,
      uid,
      username,
      post_link,
      post_text,
      experience_7d,
      comments_count,
      post_created_at
    FROM superlike_posts
    WHERE COALESCE(current_has_superlike, 0) = 0
      AND experience_7d IS NOT NULL
      AND experience_7d >= ?
      AND COALESCE(comments_count, 0) <= ?
      AND post_link IS NOT NULL
      AND TRIM(post_link) <> ''
    ORDER BY
      experience_7d DESC,
      post_created_at DESC,
      first_seen_at DESC
    LIMIT ?
  `).all(
    MIN_EXPERIENCE,
    MAX_COMMENTS,
    LIMIT
  );
}

async function focusCommentBox(page) {
  const selectors = [
    'textarea[placeholder*="评论"]',
    '[contenteditable="true"][aria-label*="评论"]',
    '[contenteditable="true"][placeholder*="评论"]',
    'div[contenteditable="true"]'
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible({ timeout: 1200 })) {
        await locator.click();
        return true;
      }
    } catch {
      // Try the next selector.
    }
  }

  return false;
}

async function main() {
  initDatabase();

  const targets = getTargets();
  if (!targets.length) {
    console.log(
      `没有符合条件的帖子：experience_7d >= ${MIN_EXPERIENCE}, comments_count <= ${MAX_COMMENTS}`
    );
    return;
  }

  console.log(`候选帖子 ${targets.length} 条，按经验值从高到低。`);
  console.log('这个助手只负责筛选、打开帖子并定位评论框；发送动作由你确认。');

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 }
  });

  const pages = context.pages();
  const page = pages[0] || await context.newPage();
  const rl = readline.createInterface({ input, output });

  try {
    for (let i = 0; i < targets.length; i += 1) {
      const row = targets[i];

      console.log('\n==============================================');
      console.log(`[${i + 1}/${targets.length}] 经验值=${row.experience_7d} | 评论=${row.comments_count}`);
      console.log(`UID=${row.uid || '-'} | ${row.username || '-'}`);
      console.log(`Post=${row.post_id}`);
      console.log(`Link=${row.post_link}`);
      if (row.post_text) {
        console.log(`文案=${String(row.post_text).replace(/\s+/g, ' ').slice(0, 160)}`);
      }

      await page.goto(row.post_link, {
        waitUntil: 'domcontentloaded',
        timeout: 20000
      }).catch(error => {
        console.warn(`打开失败：${error.message}`);
      });

      await page.waitForTimeout(1500);
      const focused = await focusCommentBox(page);
      console.log(focused ? '已定位评论框。' : '没有自动找到评论框，请手动点一下。');

      const answer = (await rl.question(
        '完成评论后按 Enter 看下一条；输入 s 跳过；输入 q 退出：'
      )).trim().toLowerCase();

      if (answer === 'q') break;
      if (answer === 's') continue;
    }
  } finally {
    rl.close();
    await context.close();
  }
}

main().catch(error => {
  console.error('[comment-assistant] 异常：', error);
  process.exitCode = 1;
});
