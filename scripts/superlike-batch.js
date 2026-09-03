const {
  startSuperLikeBatch
} = require('../src/superlike-scanner');


/**
 * ============================================================
 * SuperLike Batch 手动启动入口
 * ============================================================
 */
(async () => {

  try {

    await startSuperLikeBatch();

  } catch (error) {

    console.error(
      '[SuperLike] Batch启动失败：',
      error
    );

    process.exit(1);
  }

})();