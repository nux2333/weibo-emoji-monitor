'use strict';

const {
  createBatchLogger
} = require('../src/batch-logger');

/*
 * Mode4 独立启动入口：
 * 先接入统一 Batch Logger，再加载 HTTP 版 Mode4。
 * 日志保持原来的目录/文件命名：
 * logs/recheck-superlike/YYYYMMDD/recheck-superlike_mode4_YYYYMMDD_HHMMSS.log
 */
createBatchLogger(
  'recheck-superlike',
  'mode4'
);

require('./recheck-superlike-mode4-http');
