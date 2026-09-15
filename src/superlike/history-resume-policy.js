'use strict';

/*
 * History Resume lifecycle policy.
 *
 * Rules:
 * 1. A single empty page never clears Resume.
 * 2. Only 3 consecutive true empty pages can finish a source.
 * 3. If next-page params exist, persist them before deciding whether to pause.
 * 4. Budget exhaustion only pauses; it never clears Resume.
 * 5. Resume is cleared only for:
 *    - explicit no-next-page
 *    - consecutive true empty pages
 *    - explicit configured historical cutoff
 */

const HISTORY_ZERO_POST_THRESHOLD = Math.max(
  3,
  Number(process.env.SUPERLIKE_HISTORY_ZERO_POST_THRESHOLD) || 3
);

function isTrueEmptyPage(posts) {
  return Array.isArray(posts) && posts.length === 0;
}

function updateEmptyPageStreak(current, posts) {
  return isTrueEmptyPage(posts) ? Number(current || 0) + 1 : 0;
}

function shouldFinishForEmptyPages(streak) {
  return Number(streak || 0) >= HISTORY_ZERO_POST_THRESHOLD;
}

/*
 * Optional explicit historical cutoff.
 * Example:
 *   SUPERLIKE_HISTORY_CUTOFF_DATE=2026-08-01
 *
 * If it is not configured, History does NOT use "yesterday 00:00"
 * as a terminal boundary.
 */
function getConfiguredHistoryCutoffMs() {
  const raw = String(
    process.env.SUPERLIKE_HISTORY_CUTOFF_DATE || ''
  ).trim();

  if (!raw) {
    return null;
  }

  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(
      `SUPERLIKE_HISTORY_CUTOFF_DATE 格式错误：${raw}；应为 YYYY-MM-DD`
    );
  }

  const [, y, m, d] = match;
  // China 00:00 = UTC previous day 16:00
  return Date.UTC(Number(y), Number(m) - 1, Number(d), -8, 0, 0, 0);
}

function pageReachedConfiguredCutoff(posts, cutoffMs, parsePostCreatedAtMs) {
  if (!Number.isFinite(Number(cutoffMs))) {
    return false;
  }

  if (!Array.isArray(posts) || posts.length === 0) {
    return false;
  }

  let comparable = 0;

  for (const post of posts) {
    const ms = Number(parsePostCreatedAtMs(post));
    if (!Number.isFinite(ms)) {
      return false;
    }

    comparable++;
    if (ms > Number(cutoffMs)) {
      return false;
    }
  }

  return comparable > 0;
}

module.exports = {
  HISTORY_ZERO_POST_THRESHOLD,
  isTrueEmptyPage,
  updateEmptyPageStreak,
  shouldFinishForEmptyPages,
  getConfiguredHistoryCutoffMs,
  pageReachedConfiguredCutoff
};
