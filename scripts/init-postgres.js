'use strict';

const {
  db,
  initDatabase
} = require('../src/db');

try {
  initDatabase();
  console.log('[PostgreSQL] schema / indexes 初始化完成');
} finally {
  try {
    db.close?.();
  } catch {
    // ignore
  }
}
