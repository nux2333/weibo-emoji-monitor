'use strict';

const DEFAULT_COMMENT = '#田栩宁[超话]##微博星宝养成计划##微博星宝#泥嚎～交个朋友吧 ​';

function normalizeCommentCopies(value) {
  const input = Array.isArray(value) ? value : [];
  const copies = Array.from(new Set(
    input.map(item => String(item || '').trim()).filter(Boolean)
  )).slice(0, 50);
  return copies.length ? copies : [DEFAULT_COMMENT];
}

let currentCommentCopies = [DEFAULT_COMMENT];
try {
  if (process.env.COMMENT_TEXTS_JSON) {
    currentCommentCopies = normalizeCommentCopies(JSON.parse(process.env.COMMENT_TEXTS_JSON));
  }
} catch (_) {}

// server-api 进程：领取任务时捕获页面传来的文案，并传给随后启动的 index-http 子进程。
const childProcess = require('child_process');
const originalSpawn = childProcess.spawn;
childProcess.spawn = function patchedSpawn(command, args, options) {
  const argv = Array.isArray(args) ? args : [];
  const isCommentWorker = argv.some(value => /comment-assistant[\\/]index-http\.js$/i.test(String(value)));

  if (!isCommentWorker) {
    return originalSpawn.apply(this, arguments);
  }

  const nextOptions = options || {};
  const existingNodeOptions = String(nextOptions.env?.NODE_OPTIONS || process.env.NODE_OPTIONS || '').trim();
  const preloadOption = `--require=${__filename}`;
  nextOptions.env = {
    ...process.env,
    ...(nextOptions.env || {}),
    COMMENT_TEXTS_JSON: JSON.stringify(currentCommentCopies),
    NODE_OPTIONS: [existingNodeOptions, preloadOption].filter(Boolean).join(' ')
  };

  console.log(`[评论文案] 启动账号任务：已传入 ${currentCommentCopies.length} 条随机文案`);
  return originalSpawn.call(this, command, args, nextOptions);
};

// server-api 进程：不改原路由实现，只在领取任务 handler 前读取 comment_copies。
try {
  const express = require('express');
  const originalPost = express.application.post;
  express.application.post = function patchedPost(route, ...handlers) {
    const routeText = String(route || '');
    const isClaimRoute = /^\/api\/(?:tasks\/claim|tasks\/[^/]+\/claim)$/.test(routeText);
    if (!isClaimRoute) return originalPost.call(this, route, ...handlers);

    const captureCommentCopies = (req, res, next) => {
      if (Array.isArray(req.body?.comment_copies)) {
        currentCommentCopies = normalizeCommentCopies(req.body.comment_copies);
        console.log(`[评论文案] 页面提交 ${currentCommentCopies.length} 条文案`);
      }
      next();
    };
    return originalPost.call(this, route, captureCommentCopies, ...handlers);
  };
} catch (_) {}

// index-http 子进程：包一层 submitComment，每次真正发送前重新随机一条。
if (/index-http\.js$/i.test(String(process.argv[1] || ''))) {
  try {
    const commentAutoModule = require('./comment-auto-service');
    const originalCreate = commentAutoModule.createCommentAutoService;

    if (typeof originalCreate === 'function' && !originalCreate.__randomCopyWrapped) {
      const wrappedCreate = function createRandomCommentService(options = {}) {
        const service = originalCreate({ ...options, defaultComment: DEFAULT_COMMENT });
        const originalSubmit = service.submitComment.bind(service);

        service.submitComment = payload => {
          const copies = currentCommentCopies.length ? currentCommentCopies : [DEFAULT_COMMENT];
          const selected = copies[Math.floor(Math.random() * copies.length)] || DEFAULT_COMMENT;
          console.log(`[评论文案] 随机 ${copies.length} 条中的 1 条：${selected}`);
          return originalSubmit({ ...payload, commentText: selected });
        };
        return service;
      };

      wrappedCreate.__randomCopyWrapped = true;
      commentAutoModule.createCommentAutoService = wrappedCreate;
    }
  } catch (error) {
    console.warn(`[评论文案] Runtime加载失败：${error.message}`);
  }
}
