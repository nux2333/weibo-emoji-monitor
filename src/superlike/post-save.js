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

function initSuperLikeTable() {
  initDatabase();
}

function deletePostsByUidWithLog(
  uid,
  reason
) {
  const normalizedUid =
    String(uid || '').trim();

  if (!normalizedUid) {
    return 0;
  }

  const deleted =
    deletePostsByUidSet(
      new Set([normalizedUid])
    );

  const superLikeReason =
    String(reason || '')
      .toUpperCase()
      .startsWith('SUPERLIKE_')
    ||
    String(reason || '')
      .toUpperCase()
      === 'FEED_SUPERLIKE_ICON';

  if (
    superLikeReason
    &&
    deleted > 0
  ) {
    addSuperLikePoolExitCount(1);
  }

  // 没有实际删除候选帖时不打印日志，避免 FEED_SUPERLIKE_ICON 大量刷屏。
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

function saveTargetPost(
  monitorId,
  post,
  profileStatus = 'UNKNOWN'
) {
  const postId =
    getPostId(post);

  if (!postId) {
    return {
      status: 'skip',
      reason: 'no_post_id'
    };
  }

  const uid =
    getUid(post);

  if (!uid) {
    return {
      status: 'skip',
      reason: 'no_uid'
    };
  }

  /*
   * 三级判断 STEP 1：
   * UID 已经在 superlike_users 中 -> 直接忽略。
   * 这是纯本地 DB 查询，不产生额外微博请求。
   */
  const knownSuperLike =
    isSuperLikeUser(
      uid
    );

  if (knownSuperLike) {
    return {
      status: 'skip',
      reason: 'uid_in_superlike_users'
    };
  }

  /*
   * 三级判断 STEP 2：
   * 当前 feed Response 已明确带 chao_like。
   * 立即保存到 superlike_users，并立即清掉该 UID 已有候选。
   */
  if (
    hasSuperLike(post)
  ) {
    saveSuperLikeUser(
      monitorId,
      uid
    );

    deletePostsByUidWithLog(
      uid,
      'FEED_SUPERLIKE_ICON'
    );

    return {
      status: 'skip',
      reason: 'has_superlike'
    };
  }

  /*
   * 三级判断 STEP 3：
   * 评论 >= 21 不入库；0-20 才作为候选。
   */
  const commentsCount =
    getCommentsCount(post);

  if (
    commentsCount === null
  ) {
    return {
      status: 'skip',
      reason: 'unknown_comments'
    };
  }

  if (
    commentsCount >= MAX_COMMENTS
  ) {
    return {
      status: 'skip',
      reason: 'comments_full'
    };
  }

  const username =
    getUsername(post);

  const postLink =
    getPostLink(post);

  const postText =
    getPostText(post);

  const postCreatedAt =
    getPostCreatedAt(post);

  const postCreatedAtMs =
    parsePostCreatedAtMs(post);

  const icons =
    extractIcons(post);

  const iconSummary =
    icons.length > 0
      ? icons.join(' / ')
      : '无';

  let rawJson = null;

  try {
    rawJson =
      JSON.stringify(post);

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
  saveTargetPost
};
