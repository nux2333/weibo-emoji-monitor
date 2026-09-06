const path = require('path');

process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'test';
process.env.DB_FILE =
  process.env.TEST_DB_FILE
  || path.join(__dirname, '..', 'data', 'monitor-test.db');

/*
 * 明确使用测试数据库后，再启动 scanner。
 * 注意：这个命令仍会真实访问微博，只是所有数据库写入都进入 monitor-test.db。
 */
const {
  startSuperLikeBatch
} = require('../src/superlike-scanner');

startSuperLikeBatch()
  .catch(error => {
    console.error(
      '[TEST][SuperLike] Batch启动失败：',
      error
    );
    process.exitCode = 1;
  });
