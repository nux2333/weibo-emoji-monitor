'use strict';

/*
 * Mode2 动态评论退出阈值。
 *
 * recheck-superlike.js 文件较大，这里只在 Mode2 进程加载时对源码做定点补丁：
 * - 以入库 experience_7d + initial_comments_count 为基准；
 * - 评论经验档位：5=>+1、10=>再+2、15=>再+3、20=>再+4；
 * - 找到入库后首次能让经验达到 80 的档位；
 * - 为避免边界/刷新延迟，实际退出阈值统一再 +1：6/11/16/21；
 * - 无法仅靠后续评论达到 80 时，继续使用 21 作为兜底；
 * - 命中退出阈值后，不直接删除，先用当前 BrowserContext 的 request.get() 轻量确认 profile_allbadge；
 * - 只有明确确认超LIKE才删除，NO/失败/403/418/visitor 都保留到下一轮。
 *
 * 只对 SUPERLIKE_RECHECK_MODE=2 生效，不影响 Mode1/3/4。
 */

if (String(process.env.SUPERLIKE_RECHECK_MODE || '') === '2') {
  const fs = require('fs');
  const Module = require('module');
  const path = require('path');

  const TARGET_FILE = path.resolve(
    __dirname,
    '..',
    'scripts',
    'recheck-superlike.js'
  );

  const originalLoader = Module._extensions['.js'];
  let patched = false;

  function replaceRequired(source, from, to, label) {
    if (!source.includes(from)) {
      throw new Error(
        `[Mode2动态阈值] 找不到补丁位置：${label}，拒绝静默启动`
      );
    }
    return source.replace(from, to);
  }

  Module._extensions['.js'] = function mode2ThresholdLoader(module, filename) {
    if (!patched && path.resolve(filename) === TARGET_FILE) {
      patched = true;

      let source = fs.readFileSync(filename, 'utf8');

      source = replaceRequired(
        source,
        `/*\n * 轻量评论复检模式：\n * 评论数 >= 21 时删除。\n */\nconst LIGHT_COMMENT_DELETE_THRESHOLD = 21;`,
        `/*\n * Mode2 SQL 候选池仍只需要保留到 20 评论。\n * 真正删除阈值由 getMode2CommentDeleteThreshold() 动态计算。\n */\nconst LIGHT_COMMENT_DELETE_THRESHOLD = 21;\n\nfunction getCommentExperienceBonus(commentsCount) {\n  const count = Math.max(0, Number(commentsCount) || 0);\n  if (count >= 20) return 10;\n  if (count >= 15) return 6;\n  if (count >= 10) return 3;\n  if (count >= 5) return 1;\n  return 0;\n}\n\nfunction getMode2CommentDeleteThreshold(post) {\n  const initialExperience = Number(post?.experience_7d);\n  const initialComments = Math.max(\n    0,\n    Number(post?.initial_comments_count ?? post?.comments_count ?? 0) || 0\n  );\n\n  /*\n   * 没有可靠经验值时不提前删，继续沿用旧的 21 评论保险线。\n   */\n  if (!Number.isFinite(initialExperience)) {\n    return 21;\n  }\n\n  const initialBonus = getCommentExperienceBonus(initialComments);\n  const milestones = [5, 10, 15, 20];\n\n  for (const milestone of milestones) {\n    if (milestone <= initialComments) {\n      continue;\n    }\n\n    const gainedAfterEntry =\n      getCommentExperienceBonus(milestone) - initialBonus;\n\n    if (initialExperience + gainedAfterEntry >= 80) {\n      return milestone + 1;\n    }\n  }\n\n  return 21;\n}\n\nasync function confirmMode2SuperLikeByRequest(\n  context,\n  config,\n  uid\n) {\n  if (!context || !config || !uid) {\n    return {\n      ok: false,\n      hasSuperLike: null,\n      status: null,\n      message: 'missing context/config/uid'\n    };\n  }\n\n  const apiUrl =\n    buildLightProfileApiUrl(\n      config,\n      uid\n    );\n\n  try {\n    const response =\n      await context.request.get(\n        apiUrl,\n        {\n          timeout: LIGHT_REQUEST_TIMEOUT_MS,\n          failOnStatusCode: false\n        }\n      );\n\n    const status =\n      response.status();\n\n    const text =\n      await response.text();\n\n    if (\n      status === 403\n      || status === 418\n    ) {\n      return {\n        ok: false,\n        hasSuperLike: null,\n        status,\n        message: \`profile_allbadge HTTP \${status}\`\n      };\n    }\n\n    if (\n      status < 200\n      || status >= 300\n    ) {\n      return {\n        ok: false,\n        hasSuperLike: null,\n        status,\n        message: \`profile_allbadge HTTP \${status}\`\n      };\n    }\n\n    let json = null;\n\n    try {\n      json = JSON.parse(text);\n    } catch {\n      return {\n        ok: false,\n        hasSuperLike: null,\n        status,\n        message: 'profile_allbadge 返回的不是 JSON'\n      };\n    }\n\n    if (Number(json?.ok ?? 0) !== 1) {\n      return {\n        ok: false,\n        hasSuperLike: null,\n        status,\n        message: \`profile_allbadge API ok=\${json?.ok}\`\n      };\n    }\n\n    return {\n      ok: true,\n      hasSuperLike:\n        profileTextHasSuperLike(text),\n      status,\n      message: null\n    };\n\n  } catch (error) {\n    return {\n      ok: false,\n      hasSuperLike: null,\n      status: null,\n      message:\n        error?.message\n        || String(error)\n    };\n  }\n}`,
        '动态阈值函数'
      );

      source = replaceRequired(
        source,
        `      comments_count,\n      experience_7d,\n      comment_last_checked_at,`,
        `      comments_count,\n      experience_7d,\n      initial_comments_count,\n      comment_last_checked_at,`,
        'Mode2 SELECT initial_comments_count'
      );

      source = replaceRequired(
        source,
        `  console.log(\`# 评论 >= \${LIGHT_COMMENT_DELETE_THRESHOLD} → 删除帖子\`);\n  console.log('# 其余 → 只更新 comments_count');`,
        `  console.log('# 删除阈值：按入库经验值 + 入库评论数动态计算，理论达80档位再+1（6/11/16/21）');\n  console.log('# 命中阈值后用当前 BrowserContext 轻量请求 profile_allbadge；确认超LIKE才删除');\n  console.log('# 其余/确认失败 → 只更新 comments_count');`,
        'Mode2 启动日志'
      );

      source = replaceRequired(
        source,
        `      const commentsCount =\n        Number(result.commentsCount);\n\n      if (\n        commentsCount >=\n        LIGHT_COMMENT_DELETE_THRESHOLD\n      ) {\n        markDailyExcludedUser(\n          post.monitor_id,\n          post.uid,\n          'COMMENTS_21'\n        );\n\n        const deleted =\n          deleteAllPostsByUid(\n            post.monitor_id,\n            post.uid\n          );`,
        `      const commentsCount =\n        Number(result.commentsCount);\n\n      const deleteThreshold =\n        getMode2CommentDeleteThreshold(post);\n\n      let superLikeVerify = null;\n\n      if (\n        commentsCount >=\n        deleteThreshold\n      ) {\n        const monitor =\n          getSuperLikeMonitors()\n            .find(\n              item =>\n                Number(item.id)\n                === Number(post.monitor_id)\n            );\n\n        const config =\n          monitor\n            ? parseTopicHomepage(monitor.url)\n            : null;\n\n        superLikeVerify =\n          await confirmMode2SuperLikeByRequest(\n            context,\n            config,\n            post.uid\n          );\n\n        console.log(\n          \`[模式2][超LIKE确认] UID=\${post.uid} | Post=\${post.post_id} | \` +\n          \`当前评论=\${commentsCount} | 动态阈值=\${deleteThreshold} | \` +\n          (\n            superLikeVerify.ok\n              ? \`结果=\${superLikeVerify.hasSuperLike ? 'YES' : 'NO'} | HTTP=\${superLikeVerify.status ?? '-'}\`\n              : \`结果=FAILED | HTTP=\${superLikeVerify.status ?? '-'} | \${superLikeVerify.message || ''}\`\n          )\n        );\n      }\n\n      if (\n        commentsCount >=\n        deleteThreshold\n        && superLikeVerify?.ok\n        && superLikeVerify?.hasSuperLike === true\n      ) {\n        const deleteReason =\n          \`SUPERLIKE_MODE2_CONFIRM_\${deleteThreshold}\`;\n\n        markDailyExcludedUser(\n          post.monitor_id,\n          post.uid,\n          deleteReason\n        );\n\n        const deleted =\n          deleteAllPostsByUid(\n            post.monitor_id,\n            post.uid,\n            deleteReason\n          );`,
        'Mode2 删除判断'
      );

      source = replaceRequired(
        source,
        `          \`ID=\${post.id} | UID=\${post.uid} | Post=\${post.post_id} | 评论=\${commentsCount} | 当天排除UID | 删除=\${deleted}\``,
        `          \`ID=\${post.id} | UID=\${post.uid} | Post=\${post.post_id} | \` +\n          \`入库经验=\${post.experience_7d ?? '-'} | 入库评论=\${post.initial_comments_count ?? '-'} | \` +\n          \`当前评论=\${commentsCount} | 动态阈值=\${deleteThreshold} | 超LIKE确认=YES | 当天排除UID | 删除=\${deleted}\``,
        'Mode2 删除日志'
      );

      source = replaceRequired(
        source,
        `          \`ID=\${post.id} | Post=\${post.post_id} | 评论=\${commentsCount} | \` +\n          \`更新保留 | 下次≈\${nextMinutes}分钟后\``,
        `          \`ID=\${post.id} | Post=\${post.post_id} | 入库经验=\${post.experience_7d ?? '-'} | \` +\n          \`入库评论=\${post.initial_comments_count ?? '-'} | 当前评论=\${commentsCount} | \` +\n          \`动态阈值=\${deleteThreshold} | \` +\n          (\n            commentsCount >= deleteThreshold\n              ? \`超LIKE确认=\${superLikeVerify?.ok ? (superLikeVerify?.hasSuperLike ? 'YES' : 'NO') : 'FAILED'} | \`\n              : ''\n          ) +\n          \`更新保留 | 下次≈\${nextMinutes}分钟后\``,
        'Mode2 保留日志'
      );

      source = replaceRequired(
        source,
        `console.log('2 = 评论双队列（HOT 18-20每30秒独立；NORMAL 0-17按到期轮询；>=21删除）');`,
        `console.log('2 = 评论双队列（动态阈值6/11/16/21；命中后轻量确认超LIKE才删除）');`,
        'Mode2 菜单说明'
      );

      module._compile(source, filename);
      return;
    }

    return originalLoader(module, filename);
  };

  console.log('[Mode2动态阈值] preload 已启用：6/11/16/21 + 删除前轻量allbadge确认');
}
