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
  shouldStopAtCheckpoint
} = require('./post-utils');
const {
  checkUserSuperLikeByProfile,
  pickProfileReplacementPost
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
  preExtractedPosts = null
) {
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
   * 第二重 checkpoint 时间兜底：
   * 只有“整页所有可识别帖子都有有效时间，并且全部 <= checkpoint 时间”
   * 才把本页视为旧页。任何一条时间缺失/解析失败/晚于 checkpoint，
   * 本页都不计入连续旧页，避免误停。
   */
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


    /*
     * 命中上一轮 checkpoint 时只做标记，不中断当前页。
     * 当前页剩余帖子仍全部处理，页处理完成后由外层停止翻页，
     * 防止同一页内部时间顺序不严格导致漏帖。
     */
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
     * 当天排除：
     * 某 UID 今天任意候选帖已经达到 21 评论后，
     * 今天剩余时间 scanner 不再抓取该 UID 的任何帖子。
     */
    if (
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


    /*
     * 第一层：superlike_users 是最高优先级本地黑名单。
     * 已确认 SuperLike 的 UID 不需要再看 feed icon / Profile。
     */
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


    /*
     * 先检查评论数，再做“同 UID 本轮只保留一条”的去重。
     *
     * 原因：
     * 即使这个 UID 较新的帖子已经被处理过，
     * 后面又遇到他的另一条帖子只要评论 >=21，
     * 也必须立刻把该 UID 加入当天排除并删除已有候选。
     */
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
     * 每个用户只处理这一轮里遇到的第一条“未满21评论”的帖子。
     * 但其它帖子仍会经过上面的 >=21 检查，确保不会漏掉当天排除条件。
     */
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


    /*
     * feed 没有超LIKE icon，且 UID 也不在 superlike_users：
     * 先做 Profile 二次校验。
     *
     * 1) 同一轮同 UID 只请求一次。
     * 2) DB 最近15分钟已经确认 NO_SUPERLIKE 时直接复用。
     * 3) Profile 确认 SuperLike -> 立刻入 superlike_users 并清旧候选。
     * 4) Profile 请求失败时 fail-open：仍允许候选入库，避免漏掉真正目标。
     */
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
        /*
         * 以前这里会直接复用 NO_SUPERLIKE 缓存。
         * 现在还需要核对“原 post 是否仍在用户超话主页”并寻找替代帖，
         * 所以 scanner 必须拿到本轮真实 profile JSON，不能只靠状态缓存。
         */
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


    /*
     * 新逻辑：候选必须在该用户当前超话主页里有可用落点。
     *
     * - 原 post_id 仍在主页：保留原帖。
     * - 原 post_id 不在主页：换成主页从上往下第一条“30天内 + 评论0~3”的帖子。
     * - 主页请求成功，但两者都没有：这个 UID 不保留候选，并删除 DB 中该 UID 旧候选。
     * - Profile 请求失败：仍 fail-open，保留原帖，避免网络失败误删用户。
     */
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
