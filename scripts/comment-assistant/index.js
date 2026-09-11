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
const DEFAULT_COMMENT = process.env.COMMENT_TEXT || '[泪奔][泪奔][泪奔][泪奔][泪奔]';
const COMMENT_FP = process.env.COMMENT_FP || '';

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

async function sendComment(page, postId, commentText) {
  return page.evaluate(
    async ({ postId, commentText, fp }) => {
      const form = new URLSearchParams();
      form.set('id', String(postId));
      form.set('comment', commentText);
      form.set('pic_id', '');
      form.set('is_repost', '0');
      form.set('comment_ori', '0');
      form.set('is_comment', '0');
      if (fp) form.set('fp', fp);

      const response = await fetch('/ajax/comments/create', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/plain, */*'
        },
        body: form.toString()
      });

      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // Keep raw body for diagnostics.
      }

      return {
        ok: response.ok,
        status: response.status,
        json,
        text
      };
    },
    {
      postId,
      commentText,
      fp: COMMENT_FP
    }
  );
}

function summarizeResult(result) {
  if (!result) return '没有返回结果';

  const body = result.json || {};
  const code = body.ok ?? body.code ?? body.error_code ?? '';
  const message = body.msg || body.message || body.error || '';

  return [
    `HTTP ${result.status}`,
    code !== '' ? `code=${code}` : '',
    message ? `msg=${message}` : ''
  ].filter(Boolean).join(' | ');
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
  console.log('每条评论发送前都会要求你确认。');
  console.log(`默认评论：${DEFAULT_COMMENT}`);
  if (!COMMENT_FP) {
    console.log('COMMENT_FP 未设置：先尝试不传 fp；如果微博返回参数错误，再设置抓包里的 fp。');
  }

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

      await page.waitForTimeout(1200);

      const answer = (await rl.question(
        `发送评论“${DEFAULT_COMMENT}”？输入 y 发送；s 跳过；q 退出：`
      )).trim().toLowerCase();

      if (answer === 'q') break;
      if (answer !== 'y') continue;

      try {
        const result = await sendComment(page, row.post_id, DEFAULT_COMMENT);
        console.log(`[评论结果] ${summarizeResult(result)}`);

        if (!result.ok || (result.json && result.json.ok === 0)) {
          const raw = result.text ? String(result.text).slice(0, 500) : '';
          if (raw) console.log(`[返回内容] ${raw}`);
        }
      } catch (error) {
        console.error(`[评论失败] ${error.message}`);
      }
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
