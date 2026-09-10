'use strict';

const {
  db,
  initDatabase
} = require('../src/db');

try {
  initDatabase();

  /*
   * SQLite INTEGER 是 64 位整数，而 PostgreSQL INTEGER 只有 32 位。
   * 项目里的 *_ms 字段保存 13 位毫秒时间戳（例如 1789034301000），
   * 必须使用 BIGINT，否则迁移/运行时会报 integer out of range。
   *
   * 这里同时兼容：
   * 1. 新建 PostgreSQL 库；
   * 2. 已经被旧版兼容层创建成 INTEGER 的测试库。
   */
  db.exec(`
    ALTER TABLE superlike_scan_checkpoint
      ALTER COLUMN latest_created_at_ms TYPE BIGINT
      USING latest_created_at_ms::BIGINT;

    ALTER TABLE superlike_scan_resume
      ALTER COLUMN checkpoint_created_at_ms TYPE BIGINT
      USING checkpoint_created_at_ms::BIGINT;

    ALTER TABLE superlike_scan_source_checkpoint
      ALTER COLUMN latest_created_at_ms TYPE BIGINT
      USING latest_created_at_ms::BIGINT;

    ALTER TABLE superlike_scan_success_state
      ALTER COLUMN last_successful_scan_at_ms TYPE BIGINT
      USING last_successful_scan_at_ms::BIGINT;
  `);

  console.log('[PostgreSQL] schema / indexes 初始化完成');
  console.log('[PostgreSQL] 毫秒时间戳字段已确认使用 BIGINT');
} finally {
  try {
    db.close?.();
  } catch {
    // ignore
  }
}
