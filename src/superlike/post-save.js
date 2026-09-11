const {
  initDatabase,
  isSuperLikeUser,
  saveSuperLikeUser,
  saveSuperLikeTargetPost,
  deletePostsByUidSet,
  addSuperLikePoolExitCount,
  superLikePostIdExists
} = require('../db');
const {
  getPostId,
  getUid,
  hasSuperLike,
  getCommentsCount,
  getUsername,
  getPostLink,
  getPostText,
  getPostCreatedAt,
  parsePostCreatedAtMs,
  extractIcons
} = require('./post-utils');

const MAX_COMMENTS = 21;

function normalizePostCreatedAt(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  /* 已经是统一格式时直接保留 */
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
    return text;
  }

  /*
   * 微博原始格式：Fri Sep 11 18:05:32 +0800 2026
   * post_created_at 本身带 +0800，所以直接读取字符串里的北京时间，
   * 不做 UTC / +8 小时二次转换。
   */
  const match = text.match(
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+([+-]\d{4})\s+(\d{4})$/
  );

  if (!match) return text;

  const monthMap = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04',
    May: '05', Jun: '06', Jul: '07', Aug: '08',
    Sep: '09', Oct: '10', Nov: '11', Dec: '12'
  };

  const [, monthName, rawDay, hour, minute, second, offset, year] = match;

  /* 目前项目约定 post_created_at 保存北京时间；非 +0800 时保留原值，避免误改。 */
  if (offset !== '+0800') return text;

  const month = monthMap[monthName];
  const day = String(Number(rawDay)).padStart(2, '0');

  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function initSuperLikeTable() {
  initDatabase();
}

function deletePostsByUidWithLog(uid, reason) {
  const normalizedUid = String(uid || '').trim();
  if (!normalizedUid) return 0;

  const deleted = deletePostsByUidSet(new Set([normalizedUid]));
  const superLikeReason =
    String(reason || '').toUpperCase().startsWith('SUPERLIKE_') ||
    String(reason || '').toUpperCase() === 'FEED_SUPERLIKE_ICON';

  if (superLikeReason && deleted > 0) {
    addSuperLikePoolExitCount(1);
  }

  if (deleted > 0) {
    console.log(
      `[DB删除][UID=${normalizedUid}] 原因=${reason || 'UNSPECIFIED'} | 删除=${deleted} | 今日毕业+${superLikeReason ? 1 : 0}`
    );
  }

  return deleted;
}

function postIdExists(postId) {
  return superLikePostIdExists(postId);
}

function saveTargetPost(monitorId, post, profileStatus = 'UNKNOWN') {
  const postId = getPostId(post);
  if (!postId) return { status: 'skip', reason: 'no_post_id' };

  const uid = getUid(post);
  if (!uid) return { status: 'skip', reason: 'no_uid' };

  const knownSuperLike = isSuperLikeUser(uid);
  if (knownSuperLike) {
    return { status: 'skip', reason: 'uid_in_superlike_users' };
  }

  if (hasSuperLike(post)) {
    saveSuperLikeUser(monitorId, uid);
    deletePostsByUidWithLog(uid, 'FEED_SUPERLIKE_ICON');
    return { status: 'skip', reason: 'has_superlike' };
  }

  const commentsCount = getCommentsCount(post);
  if (commentsCount === null) {
    return { status: 'skip', reason: 'unknown_comments' };
  }
  if (commentsCount >= MAX_COMMENTS) {
    return { status: 'skip', reason: 'comments_full' };
  }

  const username = getUsername(post);
  const postLink = getPostLink(post);
  const postText = getPostText(post);
  const postCreatedAt = normalizePostCreatedAt(getPostCreatedAt(post));
  const postCreatedAtMs = parsePostCreatedAtMs(post);
  const icons = extractIcons(post);
  const iconSummary = icons.length > 0 ? icons.join(' / ') : '无';

  let rawJson = null;
  try {
    rawJson = JSON.stringify(post);
  } catch {
    rawJson = null;
  }

  return saveSuperLikeTargetPost({
    monitorId,
    postId,
    uid,
    username,
    postLink,
    postText,
    commentsCount,
    iconSummary,
    postCreatedAt,
    postCreatedAtMs,
    profileStatus,
    rawJson
  });
}

module.exports = {
  initSuperLikeTable,
  deletePostsByUidWithLog,
  postIdExists,
  saveTargetPost,
  normalizePostCreatedAt
};
