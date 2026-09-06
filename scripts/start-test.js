const path = require('path');

process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'test';
process.env.PORT = process.env.TEST_PORT || '3001';
process.env.DB_FILE =
  process.env.TEST_DB_FILE
  || path.join(__dirname, '..', 'data', 'monitor-test.db');

/*
 * Web/API only.
 * server.js itself does not auto-run batch jobs.
 */
require('../server');
