const {
  markDailyExcludedUser,
  isDailyExcludedUser,
  isSuperLikeUser,
  saveSuperLikeUser
} = require('../db');

const {
  getPostId,
  getUid,
  hasSuperLike,
  getCommentsCount,
  getPostCreatedAt,
  parsePostCreatedAtMs,
  getNewestPostInfo,
  shouldStopAtCheckpoint,
  findPosts
} = require('./post-utils');

const {
  saveTargetPost,
  deletePostsByUidWithLog
} = require('./post-save');

const MAX_COMMENTS = 21;

async function processPagePosts(
  monitorId,
  json,
  seenThisRun,
  seenUidThisRun,
  deleteUidSet,
  checkpoint,
  context,
  config,
  profileCache,
  reusableProfileContext = null,
  preExtractedPosts = null,
  minCreatedAtMs = null,
  options = null
) {
  const processingMode =
    String(
      options?.mode
      || ''
    );

  const hotMode =
    processingMode === 'hot';

  const stats = {
    found: 0,
    duplicateInRun: 0,
    duplicateUidInRun: 0,
    existingInDb: 0,
    unknownComments: 0,
    commentsFull: 0,
    hasSuperLike: 0,
    deleteQueued: 0,
    target: 0,
    inserted: 0,
    replaced: 0,
    profileChecked: 0,
    profileCached: 0,
    profileSuperLike: 0,
    profileFailed: 0,
    olderThanMinCreatedAt: 0,
    checkpointReached: false,
    pageFullyAtOrBeforeCheckpoint: false,
    pageHasNoPosts: false,
    newestSeen: null
  };

  const posts =
    Array.isArray(
      preExtractedPosts
    )
      ? preExtractedPosts
      : findPosts(
          json
        );

  stats.newestSeen =
    getNewestPostInfo(
      posts
    );

  stats.pageHasNoPosts =
    posts.length === 0;

  /*
   * checkpoint 时间兜底：只有整页所有可识别帖子都有有效时间，
   * 并且全部 <= checkpoint 时间，才把本页视为旧页。
   */
  if (
    checkpoint
    && Number.isFinite(
      Number(
        checkpoint.latest_created_at_ms
      )
    )
    && posts.length > 0
  ) {
    const checkpointMs =
      Number(
        checkpoint.latest_created_at_ms
      );

    let comparablePosts = 0;
    let allComparable = true;
    let allAtOrBefore = true;

    for (const post of posts) {
      const postId =
        getPostId(
          post
        );

      if (!postId) {
        continue;
      }

      const createdAtMs =
        parsePostCreatedAtMs(
          post
        );

      if (
        !Number.isFinite(
          Number(
            createdAtMs
          )
        )
      ) {
        allComparable = false;
        allAtOrBefore = false;
        break;
      }

      comparablePosts++;

      if (
        Number(
          createdAtMs
        ) > checkpointMs
      ) {
        allAtOrBefore = false;
        break;
      }
    }

    stats.pageFullyAtOrBeforeCheckpoint =
      comparablePosts > 0
      && allComparable
      && allAtOrBefore;
  }

  for (const post of posts) {
    const postId =
      getPostId(
        post
      );

    if (!postId) {
      continue;
    }

    /*
     * History 可传入最早允许时间。
     * 明确早于该时间的帖子直接跳过。
     */
    const minCreatedAt =
      Number(
        minCreatedAtMs
      );

    if (
      Number.isFinite(
        minCreatedAt
      )
    ) {
      const createdAtMs =
        parsePostCreatedAtMs(
          post
        );

      if (
        Number.isFinite(
          Number(
            createdAtMs
          )
        )
        && Number(
          createdAtMs
        ) < minCreatedAt
      ) {
        stats.olderThanMinCreatedAt++;
        continue;
      }
    }

    if (
      seenThisRun.has(
        postId
      )
    ) {
      stats.duplicateInRun++;
      continue;
    }

    seenThisRun.add(
      postId
    );

    stats.found++;

    if (
      shouldStopAtCheckpoint(
        post,
        checkpoint
      )
    ) {
      if (!stats.checkpointReached) {
        console.log(
          `[SuperLike][Checkpoint] 本页发现上一轮 Post=${postId} time=${getPostCreatedAt(post) || '-'}；继续处理完整当前页。`
        );
      }

      stats.checkpointReached = true;
    }

    const uid =
      getUid(
        post
      );

    /*
     * 非热门来源继续沿用当天排除。
     */
    if (
      !hotMode
      && uid
      && isDailyExcludedUser(
        monitorId,
        uid
      )
    ) {
      console.log(
        `[SuperLike][当天排除] UID=${uid} 今天已有帖子达到21评论，跳过所有帖子`
      );
      continue;
    }

    /*
     * 已知 SuperLike 用户直接过滤，不再查主页。
     */
    if (
      uid
      && isSuperLikeUser(
        uid
      )
    ) {
      stats.hasSuperLike++;

      if (!deleteUidSet.has(uid)) {
        stats.deleteQueued++;
      }

      deleteUidSet.add(uid);

      console.log(
        `[SuperLike][本地命中] UID=${uid} 已存在 superlike_users，直接忽略`
      );

      continue;
    }

    /*
     * Feed 本身已经带 chao_like 时，直接确认并过滤。
     */
    if (
      hasSuperLike(
        post
      )
    ) {
      stats.hasSuperLike++;

      if (uid) {
        if (!deleteUidSet.has(uid)) {
          stats.deleteQueued++;
        }

        deleteUidSet.add(uid);

        const userInserted =
          saveSuperLikeUser(
            monitorId,
            uid
          );

        console.log(
          userInserted
            ? `[SuperLike][SuperLike用户入库] UID=${uid} 已写入 superlike_users`
            : `[SuperLike][SuperLike用户已存在] UID=${uid} superlike_users 已有记录`
        );

        console.log(
          `[SuperLike][待删除] UID=${uid} feed Response发现 chao_like`
        );
      }

      continue;
    }

    const commentsCount =
      getCommentsCount(
        post
      );

    if (
      commentsCount === null
    ) {
      stats.unknownComments++;
      continue;
    }

    if (
      commentsCount >=
      MAX_COMMENTS
    ) {
      stats.commentsFull++;

      if (uid) {
        markDailyExcludedUser(
          monitorId,
          uid,
          'COMMENTS_21'
        );

        const deletedNow =
          deletePostsByUidWithLog(
            uid,
            'COMMENTS_21'
          );

        console.log(
          `[SuperLike][评论>=21当天排除] UID=${uid} | Post=${postId} | 评论=${commentsCount} | 清理旧候选=${deletedNow}`
        );
      }

      continue;
    }

    /*
     * 同一轮同一 UID 只保留第一条未满21评论的 Feed 帖子。
     */
    if (
      uid
      && seenUidThisRun.has(
        uid
      )
    ) {
      stats.duplicateUidInRun++;
      continue;
    }

    if (uid) {
      seenUidThisRun.add(
        uid
      );
    }

    if (!uid) {
      console.log(
        `[SuperLike][跳过] Post=${postId} 没有UID，不入库`
      );
      continue;
    }

    /*
     * Scanner 不再执行主页/Profile 二次确认。
     * 是否已经成为 SuperLike 交给：
     * 1. JYZ 补数（experience_7d >= 80 直接清理）
     * 2. Mode3 profile_allbadge 最终兜底
     *
     * 因此这里直接使用 Feed 帖子入库，状态记为 UNKNOWN。
     */
    stats.target++;

    try {
      const saved =
        saveTargetPost(
          monitorId,
          post,
          'UNKNOWN'
        );

      if (
        saved.status ===
        'inserted'
      ) {
        stats.inserted++;

        console.log(
          [
            '[SuperLike][新增]',
            `UID=${saved.uid || '-'}`,
            `用户=${saved.username || '-'}`,
            `评论=${saved.commentsCount}`,
            `Icon=${saved.iconSummary || '无'}`,
            saved.postLink || '-'
          ].join(' | ')
        );
      } else if (
        saved.status ===
        'replaced'
      ) {
        stats.replaced++;

        console.log(
          [
            '[SuperLike][更新UID最新帖]',
            `UID=${saved.uid || '-'}`,
            `用户=${saved.username || '-'}`,
            `评论=${saved.commentsCount}`,
            saved.postLink || '-'
          ].join(' | ')
        );
      } else if (
        saved.status ===
        'kept_existing'
      ) {
        stats.existingInDb++;
      }
    } catch (error) {
      if (
        String(
          error.message
        )
          .toLowerCase()
          .includes(
            'unique'
          )
      ) {
        stats.existingInDb++;
        continue;
      }

      throw error;
    }
  }

  return stats;
}

module.exports = {
  processPagePosts
};
