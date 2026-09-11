'use strict';

/*
 * 唯一建议的手动 initDatabase 入口。
 *
 * 正常服务/批处理都会加载 skip-db-init-preload.js，默认跳过 initDatabase。
 * 本脚本故意不加载该 preload，并显式允许初始化。
 */
process.env.ALLOW_DB_INIT = '1';

const {
  initDatabase
} = require('../src/db');

console.log('[DB初始化] 手动执行 initDatabase 开始...');

initDatabase();

console.log('[DB初始化] initDatabase 执行完成。');
