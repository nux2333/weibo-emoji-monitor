'use strict';

/*
 * Scan Checkpoint 统一层
 *
 * 目标：只保留一张 superlike_scan_checkpoint，使用
 *   PRIMARY KEY (monitor_id, source_key)
 * 区分 latest-posts 与各专区。
 *
 * 为了降低 Scanner 改动风险，这里继续兼容旧 API：
 *   get/saveScanCheckpoint            -> source_key=latest-posts
 *   get/saveScanSourceCheckpoint      -> source_key=<专区>
 */

const dbModule = require('./db');
const { db, initDatabase } = dbModule;

const LATEST_SOURCE_KEY = 'latest-posts';

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function safeAll(sql) {
  try {
    return db.prepare(sql).all();
  } catch {
    return [];
  }
}

function isUnifiedSchema() {
  try {
    db.prepare(`
      SELECT source_key
      FROM superlike_scan_checkpoint
      LIMIT 1
    `).get();
    return true;
  } catch {
    return false;
  }
}

function migrateOnce() {
  initDatabase();

  if (isUnifiedSchema()) {
    /*
     * 旧 db.js 每次初始化仍可能创建兼容表。
     * 如果里面存在数据，先并回主表再删除。
     */
    const sourceRows = safeAll(`
      SELECT
        monitor_id,
        source_key,
        latest_post_id,
        latest_created_at,
        latest_created_at_ms,
        updated_at
      FROM superlike_scan_source_checkpoint
    `);

    if (sourceRows.length > 0) {
      const upsert = db.prepare(`
        INSERT INTO superlike_scan_checkpoint(
          monitor_id,
          source_key,
          latest_post_id,
          latest_created_at,
          latest_created_at_ms,
          updated_at
        )
        VALUES(?,?,?,?,?,?)
        ON CONFLICT(monitor_id, source_key)
        DO UPDATE SET
          latest_post_id = excluded.latest_post_id,
          latest_created_at = excluded.latest_created_at,
          latest_created_at_ms = excluded.latest_created_at_ms,
          updated_at = excluded.updated_at
      `);

      for (const row of sourceRows) {
        upsert.run(
          Number(row.monitor_id),
          String(row.source_key),
          String(row.latest_post_id),
          row.latest_created_at == null
            ? null
            : String(row.latest_created_at),
          row.latest_created_at_ms == null
            ? null
            : Number(row.latest_created_at_ms),
          row.updated_at || new Date().toISOString()
        );
      }
    }

    db.exec('DROP TABLE IF EXISTS superlike_scan_source_checkpoint');
    return;
  }

  const latestRows = safeAll(`
    SELECT
      monitor_id,
      latest_post_id,
      latest_created_at,
      latest_created_at_ms,
      updated_at
    FROM superlike_scan_checkpoint
  `);

  const sourceRows = safeAll(`
    SELECT
      monitor_id,
      source_key,
      latest_post_id,
      latest_created_at,
      latest_created_at_ms,
      updated_at
    FROM superlike_scan_source_checkpoint
  `);

  db.exec('BEGIN');

  try {
    db.exec(`
      DROP TABLE IF EXISTS superlike_scan_checkpoint_unified_tmp;

      CREATE TABLE superlike_scan_checkpoint_unified_tmp (
        monitor_id INTEGER NOT NULL,
        source_key TEXT NOT NULL,
        latest_post_id TEXT NOT NULL,
        latest_created_at TEXT,
        latest_created_at_ms INTEGER,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(monitor_id, source_key),
        FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
      );
    `);

    const insert = db.prepare(`
      INSERT INTO superlike_scan_checkpoint_unified_tmp(
        monitor_id,
        source_key,
        latest_post_id,
        latest_created_at,
        latest_created_at_ms,
        updated_at
      )
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(monitor_id, source_key)
      DO UPDATE SET
        latest_post_id = excluded.latest_post_id,
        latest_created_at = excluded.latest_created_at,
        latest_created_at_ms = excluded.latest_created_at_ms,
        updated_at = excluded.updated_at
    `);

    for (const row of latestRows) {
      if (!row.latest_post_id) continue;

      insert.run(
        Number(row.monitor_id),
        LATEST_SOURCE_KEY,
        String(row.latest_post_id),
        row.latest_created_at == null
          ? null
          : String(row.latest_created_at),
        row.latest_created_at_ms == null
          ? null
          : Number(row.latest_created_at_ms),
        row.updated_at || new Date().toISOString()
      );
    }

    for (const row of sourceRows) {
      if (!row.latest_post_id || !row.source_key) continue;

      insert.run(
        Number(row.monitor_id),
        String(row.source_key),
        String(row.latest_post_id),
        row.latest_created_at == null
          ? null
          : String(row.latest_created_at),
        row.latest_created_at_ms == null
          ? null
          : Number(row.latest_created_at_ms),
        row.updated_at || new Date().toISOString()
      );
    }

    db.exec(`
      DROP TABLE IF EXISTS superlike_scan_checkpoint;
      ALTER TABLE superlike_scan_checkpoint_unified_tmp
        RENAME TO superlike_scan_checkpoint;
      DROP TABLE IF EXISTS superlike_scan_source_checkpoint;
    `);

    db.exec('COMMIT');

    console.log(
      `[ScanCheckpoint] 已统一 Checkpoint 表 | latest=${latestRows.length} | source=${sourceRows.length}`
    );
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback failure
    }
    throw error;
  }
}

function ensureUnifiedSchema() {
  let lastError = null;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      migrateOnce();
      if (isUnifiedSchema()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    sleepSync(300 * attempt);
  }

  throw lastError || new Error('Scan Checkpoint 统一迁移失败');
}

ensureUnifiedSchema();

function getCheckpointBySource(monitorId, sourceKey) {
  return db.prepare(`
    SELECT
      monitor_id,
      source_key,
      latest_post_id,
      latest_created_at,
      latest_created_at_ms,
      updated_at
    FROM superlike_scan_checkpoint
    WHERE monitor_id = ?
      AND source_key = ?
  `).get(
    Number(monitorId),
    String(sourceKey)
  ) || null;
}

function saveCheckpointBySource(
  monitorId,
  sourceKey,
  latestPostId,
  latestCreatedAt,
  latestCreatedAtMs
) {
  if (
    !monitorId
    || !sourceKey
    || !latestPostId
  ) {
    return false;
  }

  db.prepare(`
    INSERT INTO superlike_scan_checkpoint(
      monitor_id,
      source_key,
      latest_post_id,
      latest_created_at,
      latest_created_at_ms,
      updated_at
    )
    VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(monitor_id, source_key)
    DO UPDATE SET
      latest_post_id = excluded.latest_post_id,
      latest_created_at = excluded.latest_created_at,
      latest_created_at_ms = excluded.latest_created_at_ms,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    Number(monitorId),
    String(sourceKey),
    String(latestPostId),
    latestCreatedAt || null,
    Number.isFinite(Number(latestCreatedAtMs))
      ? Number(latestCreatedAtMs)
      : null
  );

  return true;
}

function getScanCheckpoint(monitorId) {
  const row = getCheckpointBySource(
    monitorId,
    LATEST_SOURCE_KEY
  );

  if (!row) return null;

  return {
    monitor_id: row.monitor_id,
    latest_post_id: row.latest_post_id,
    latest_created_at: row.latest_created_at,
    latest_created_at_ms: row.latest_created_at_ms,
    updated_at: row.updated_at
  };
}

function saveScanCheckpoint(
  monitorId,
  latestPostId,
  latestCreatedAt,
  latestCreatedAtMs
) {
  if (
    !latestPostId
    || !Number.isFinite(Number(latestCreatedAtMs))
  ) {
    return false;
  }

  return saveCheckpointBySource(
    monitorId,
    LATEST_SOURCE_KEY,
    latestPostId,
    latestCreatedAt,
    latestCreatedAtMs
  );
}

function getScanSourceCheckpoint(
  monitorId,
  sourceKey
) {
  return getCheckpointBySource(
    monitorId,
    sourceKey
  );
}

function saveScanSourceCheckpoint(
  monitorId,
  sourceKey,
  latestPostId,
  latestCreatedAt,
  latestCreatedAtMs
) {
  return saveCheckpointBySource(
    monitorId,
    sourceKey,
    latestPostId,
    latestCreatedAt,
    latestCreatedAtMs
  );
}

/*
 * Scanner 后续 require('./db') 命中同一份 module.exports，
 * 所以保持旧函数签名即可切换到统一 checkpoint 表。
 */
dbModule.getScanCheckpoint = getScanCheckpoint;
dbModule.saveScanCheckpoint = saveScanCheckpoint;
dbModule.getScanSourceCheckpoint = getScanSourceCheckpoint;
dbModule.saveScanSourceCheckpoint = saveScanSourceCheckpoint;
