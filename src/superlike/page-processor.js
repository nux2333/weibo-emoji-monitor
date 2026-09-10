const {
  markDailyExcludedUser,
  isDailyExcludedUser,
  isSuperLikeUser,
  getRecentSuperLikeProfileStatus,
  markSuperLikeProfileChecked,
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
  checkUserSuperLikeByProfile,
  pickProfileReplacementPost,
  pickHotProfileCandidatePost
} = require('./profile');
const {
  saveTargetPost,
  deletePostsByUidWithLog
} = require('./post-save');

const MAX_COMMENTS = 21;
const SCAN_PROFILE_CACHE_MINUTES =
  Number(process.env.SUPERLIKE_SCAN_PROFILE_CACHE_MINUTES)
  || 15;

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

  if (
    checkpoint
    && Number.isFinite(Number(checkpoint.latest_created_at_ms))
    && posts.length > 0
  ) {
    const checkpointMs = Number(checkpoint.latest_created_at_ms);
    let comparablePosts = 0;
    let allComparable = true;
    let allAtOrBefore = true;

    for (const post of posts) {
      const postId = getPostId(post);

      if (!postId) {
        continue;
      }

      const createdAtMs = parsePostCreatedAtMs(post);

      if (!Number.isFinite(Number(createdAtMs))) {
        allComparable = false;
        allAtOrBefore = false;
        break;
      }

      comparablePosts++;

      if (Number(createdAtMs) > checkpointMs) {
        allAtOrBefore = false;
        break;
      }
    }

    stats.pageFullyAtOrBeforeCheckpoint =
      comparablePosts > 0
      && allComparable
      && allAtOrBefore;
  }

  for (
    const post
    of posts
  ) {
    const postId =
      getPostId(
        post
      );

    if (!postId) {
      continue;
    }

    const minCreatedAt =
      Number(minCreatedAtMs);

    if (
      Number.isFinite(minCreatedAt)
    ) {
      const createdAtMs =
        parsePostCreatedAtMs(post);

      if (
        Number.isFinite(Number(createdAtMs))
        &&
        Number(createdAtMs) < minCreatedAt
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

    if (
      !hotMode
      &&
      uid
      &&
      isDailyExcludedUser(
        monitorId,
        uid
      )
    ) {
      console.log(
        `[SuperLike][当天排除] UID=${uid} 今天已有帖子达到21评论，跳过所有帖子`
      );
      continue;
    }

    if (
      uid
      &&
      isSuperLikeUser(
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
          saveSuperLikeUser(monitorId, uid);

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

    if (hotMode) {
      const hotFeedComments =
        getCommentsCount(
          post
        );

      if (
        hotFeedComments !== null
        &&
        hotFeedComments > 50
      ) {
        console.log(
          `[SuperLike][热门跳过] UID=${uid || '-'} FeedPost=${postId} 评论=${hotFeedComments} > 50，不查主页`
        );
        continue;
      }

      if (
        uid
        &&
        seenUidThisRun.has(uid)
      ) {
        stats.duplicateUidInRun++;
        continue;
      }

      if (!uid) {
        console.log(
          `[SuperLike][热门跳过] Post=${postId} 没有UID`
        );
        continue;
      }

      seenUidThisRun.add(uid);

      let profileResult =
        profileCache.get(uid)
        || null;

      if (!profileResult) {
        stats.profileChecked++;

        console.log(
          `[SuperLike][热门Profile] UID=${uid} feed无超LIKE；忽略feed评论数，检查主页第一页`
        );

        profileResult =
          await checkUserSuperLikeByProfile(
            context,
            config,
            uid,
            reusableProfileContext
          );

        profileCache.set(
          uid,
          profileResult
        );
      }

      if (
        profileResult?.ok
        &&
        profileResult.hasSuperLike
      ) {
        stats.hasSuperLike++;
        stats.profileSuperLike++;

        const userInserted =
          saveSuperLikeUser(
            monitorId,
            uid
          );

        if (!deleteUidSet.has(uid)) {
          stats.deleteQueued++;
        }

        deleteUidSet.add(uid);

        console.log(
          `[SuperLike][热门跳过] UID=${uid} 主页确认SuperLike | ${userInserted ? '写入' : '已存在'} superlike_users`
        );

        continue;
      }

      if (
        !profileResult?.ok
        ||
        !Array.isArray(
          profileResult.profilePosts
        )
      ) {
        stats.profileFailed++;

        console.log(
          `[SuperLike][热门跳过] UID=${uid} 主页第一页获取失败，不使用feed帖子兜底 | ${profileResult?.message || '-'}`
        );

        continue;
      }

      const targetPost =
        pickHotProfileCandidatePost(
          profileResult.profilePosts
        );

      if (!targetPost) {
        console.log(
          `[SuperLike][热门跳过] UID=${uid} 主页第一页没有评论<21的帖子`
        );

        continue;
      }

      stats.target++;

      console.log(
        `[SuperLike][热门主页候选] UID=${uid} | Post=${getPostId(targetPost)} | 评论=${getCommentsCount(targetPost)} | 时间=${getPostCreatedAt(targetPost) || '-'}`
      );

      try {
        const saved =
          saveTargetPost(
            monitorId,
            targetPost,
            'NO_SUPERLIKE'
          );

        if (
          saved.status ===
          'inserted'
        ) {
          stats.inserted++;
        } else if (
          saved.status ===
          'replaced'
        ) {
          stats.replaced++;
        } else if (
          saved.status ===
          'kept_existing'
        ) {
          stats.existingInDb++;
        }

        markSuperLikeProfileChecked(
          monitorId,
          uid,
          'NO_SUPERLIKE'
        );

      } catch (error) {
        if (
          String(error.message)
            .toLowerCase()
            .includes('unique')
        ) {
          stats.existingInDb++;
          continue;
        }

        throw error;
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

    if (
      uid
      &&
      seenUidThisRun.has(
        uid
      )
    ) {
      stats.duplicateUidInRun++;
      continue;
    }

    if (uid) {
      seenUidThisRun.add(uid);
    }

    if (!uid) {
      console.log(
        `[SuperLike][跳过] Post=${postId} 没有UID，不入库`
      );

      continue;
    }

    let profileResult =
      profileCache.get(uid)
      || null;

    if (!profileResult) {
      const recent =
        getRecentSuperLikeProfileStatus(
          monitorId,
          uid,
          SCAN_PROFILE_CACHE_MINUTES
        );

      if (
        recent
        &&
        String(recent.status).toUpperCase()
          === 'NO_SUPERLIKE'
      ) {
        console.log(
          `[SuperLike][Profile缓存仅状态] UID=${uid} 最近已确认非SuperLike，但本轮仍请求主页用于帖子核对`
        );
      }
    }

    if (!profileResult) {
      stats.profileChecked++;

      console.log(
        `[SuperLike][Profile校验] UID=${uid} feed无超LIKE，开始二次确认...`
      );

      profileResult =
        await checkUserSuperLikeByProfile(
          context,
          config,
          uid,
          reusableProfileContext
        );

      profileCache.set(
        uid,
        profileResult
      );
    }

    if (
      profileResult?.ok
      &&
      profileResult.hasSuperLike
    ) {
      stats.hasSuperLike++;
      stats.profileSuperLike++;

      const userInserted =
        saveSuperLikeUser(
          monitorId,
          uid
        );

      const deletedNow =
        deletePostsByUidWithLog(
          uid,
          'SUPERLIKE_PROFILE_CONFIRMED'
        );

      if (!deleteUidSet.has(uid)) {
        stats.deleteQueued++;
      }

      deleteUidSet.add(uid);

      console.log(
        `[SuperLike][Profile命中] UID=${uid} 已确认SuperLike | ` +
        `${userInserted ? '写入' : '已存在'} superlike_users | 清理旧候选=${deletedNow}`
      );

      continue;
    }

    if (
      profileResult
      &&
      !profileResult.ok
    ) {
      stats.profileFailed++;

      console.log(
        `[SuperLike][Profile失败] UID=${uid} | ${profileResult.message || 'unknown'} | Profile最多2次、单次5秒，整体最多15秒；失败后fail-open入库，后续交给Mode3/删除Batch清理`
      );
    }

    let targetPost = post;

    if (
      profileResult?.ok
      &&
      Array.isArray(profileResult.profilePosts)
    ) {
      const profilePosts =
        profileResult.profilePosts;

      const originalOnProfile =
        profilePosts.some(
          profilePost =>
            String(
              getPostId(
                profilePost
              )
            )
            ===
            String(
              postId
            )
        );

      console.log(
        `[SuperLike][Profile原帖检查] UID=${uid} FeedPost=${postId} | ${originalOnProfile ? 'FOUND' : 'NOT_FOUND'}`
      );

      if (!originalOnProfile) {
        const replacementPost =
          pickProfileReplacementPost(
            profilePosts
          );

        if (replacementPost) {
          targetPost =
            replacementPost;

          console.log(
            `[SuperLike][主页替换] UID=${uid} 原Post=${postId} 不在主页 -> 替换为 Post=${getPostId(replacementPost)} 评论=${getCommentsCount(replacementPost)} 时间=${getPostCreatedAt(replacementPost) || '-'}`
          );
        } else {
          const deletedNow =
            deletePostsByUidWithLog(
              uid,
              'PROFILE_NO_USABLE_POST'
            );

          console.log(
            `[SuperLike][PROFILE_NO_USABLE_POST][本来应该入库→被扔掉] UID=${uid} | FeedPost=${postId} | Feed评论=${commentsCount} | 原帖不在Profile主页 | 30天内无评论1~4替代帖 | 原逻辑保持：不入库并清理旧候选=${deletedNow}`
          );

          continue;
        }
      } else {
        console.log(
          `[SuperLike][主页命中原帖] UID=${uid} Post=${postId} 仍在超话主页，保持原帖`
        );
      }
    }

    stats.target++;

    try {
      const saved =
        saveTargetPost(
          monitorId,
          targetPost,
          profileResult
          && !profileResult.ok
          && Number(profileResult.status) !== 403
            ? 'PROFILE_FAILED'
            : (
                profileResult?.ok
                && profileResult.hasSuperLike === false
                  ? 'NO_SUPERLIKE'
                  : 'UNKNOWN'
              )
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

      if (
        profileResult?.ok
        &&
        profileResult.hasSuperLike === false
      ) {
        markSuperLikeProfileChecked(
          monitorId,
          uid,
          'NO_SUPERLIKE'
        );
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

module.exports = { processPagePosts };
