const path = require('path');

process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'test';
process.env.DB_FILE =
  process.env.TEST_DB_FILE
  || path.join(__dirname, '..', 'data', 'monitor-test.db');

/*
 * 明确使用测试数据库后，再加载 scanner。
 * 注意：这个命令仍会真实访问微博，只是不会写正式数据库。
 */
require('../src/superlike-scanner');
