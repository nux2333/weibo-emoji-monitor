'use strict';

/*
 * Scan Resume 统一层
 *
 * 目标：只保留一张 superlike_scan_resume，使用
 *   PRIMARY KEY (monitor_id, source_key)
 * 区分 latest-posts 与各专区。
 *
 * 这个 preload 在 scan worker 正式加载 scanner 之前执行：
 * 1. 让旧 db.js 先完成基础初始化；
 * 2. 一次性把旧 superlike_scan_resume + superlike_scan_source_resume
 *    合并到新的 superlike_scan_resume；
 * 3. 覆盖 db.js 导出的 Resume API，使旧 Scanner 调用方式无需改动。
 */

const dbModule = require('./db');
const { db, initDatabase } = dbModule;

const LATEST_SOURCE_KEY = 'latest-posts';

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function isUnifiedSchema() {
  try {
    db.prepare(`
      SELECT source_key
      FROM superlike_scan_resume
      LIMIT 1
    `).get();
    return true;
  } catch {
    return false;
  }
}

function safeAll(sql) {
  try {
    return db.prepare(sql).all();
  } catch {
    return [];
  }
}

function migrateOnce() {
  initDatabase();

  /*
   * db.js 旧初始化逻辑仍可能临时创建 source_resume。
   * 如果主表已经是统一结构，只需要把这个空/旧兼容表清掉。
   */
  if (isUnifiedSchema()) {
    try {
      const rows = safeAll(`
        SELECT
          monitor_id,
          source_key,
          flow_id,
          next_page,
          next_since_id,
          next_max_id,
          next_count,
          next_page_common_ext,
          updated_at
        FROM superlike_scan_source_resume
      `);

      if (rows.length > 0) {
        const upsert = db.prepare(`
          INSERT INTO superlike_scan_resume(
            monitor_id,
            source_key,
            flow_id,
            template_url,
            checkpoint_post_id,
            checkpoint_created_at_ms,
            next_page,
            next_since_id,
            next_max_id,
            next_count,
            next_page_common_ext,
            updated_at
          )
          VALUES(?,?,?,NULL,NULL,NULL,?,?,?,?,?,?)
          ON CONFLICT(monitor_id, source_key)
          DO UPDATE SET
            flow_id = excluded.flow_id,
            next_page = excluded.next_page,
            next_since_id = excluded.next_since_id,
            next_max_id = excluded.next_max_id,
            next_count = excluded.next_count,
            next_page_common_ext = excluded.next_page_common_ext,
            updated_at = excluded.updated_at
        `);

        for (const row of rows) {
          upsert.run(
            Number(row.monitor_id),
            String(row.source_key),
            String(row.flow_id),
            row.next_page == null ? null : Number(row.next_page),
            row.next_since_id == null ? null : String(row.next_since_id),
            row.next_max_id == null ? null : String(row.next_max_id),
            row.next_count == null ? null : String(row.next_count),
            row.next_page_common_ext == null ? null : String(row.next_page_common_ext),
            row.updated_at || new Date().toISOString()
          );
        }
      }

      db.exec('DROP TABLE IF EXISTS superlike_scan_source_resume');
    } catch {
      // 另一个 scan worker 可能正在同时完成相同迁移；下一次重试处理。
    }
    return;
  }

  const latestRows = safeAll(`
    SELECT
      monitor_id,
      checkpoint_post_id,
      checkpoint_created_at_ms,
      sort_time_flow_id,
      template_url,
      next_page,
      next_since_id,
      next_max_id,
      updated_at
    FROM superlike_scan_resume
  `);

  const sourceRows = safeAll(`
    SELECT
      monitor_id,
      source_key,
      flow_id,
      next_page,
      next_since_id,
      next_max_id,
      next_count,
      next_page_common_ext,
      updated_at
    FROM superlike_scan_source_resume
  `);

  db.exec('BEGIN');

  try {
    db.exec(`
      DROP TABLE IF EXISTS superlike_scan_resume_unified_tmp;

      CREATE TABLE superlike_scan_resume_unified_tmp (
        monitor_id INTEGER NOT NULL,
        source_key TEXT NOT NULL,
        flow_id TEXT NOT NULL,
        template_url TEXT,
        checkpoint_post_id TEXT,
        checkpoint_created_at_ms INTEGER,
        next_page INTEGER,
        next_since_id TEXT,
        next_max_id TEXT,
        next_count TEXT,
        next_page_common_ext TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(monitor_id, source_key),
        FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
      );
    `);

    const insert = db.prepare(`
      INSERT INTO superlike_scan_resume_unified_tmp(
        monitor_id,
        source_key,
        flow_id,
        template_url,
        checkpoint_post_id,
        checkpoint_created_at_ms,
        next_page,
        next_since_id,
        next_max_id,
        next_count,
        next_page_common_ext,
        updated_at
      )
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(monitor_id, source_key)
      DO UPDATE SET
        flow_id = excluded.flow_id,
        template_url = excluded.template_url,
        checkpoint_post_id = excluded.checkpoint_post_id,
        checkpoint_created_at_ms = excluded.checkpoint_created_at_ms,
        next_page = excluded.next_page,
        next_since_id = excluded.next_since_id,
        next_max_id = excluded.next_max_id,
        next_count = excluded.next_count,
        next_page_common_ext = excluded.next_page_common_ext,
        updated_at = excluded.updated_at
    `);

    for (const row of latestRows) {
      insert.run(
        Number(row.monitor_id),
        LATEST_SOURCE_KEY,
        String(row.sort_time_flow_id),
        row.template_url == null ? null : String(row.template_url),
        row.checkpoint_post_id == null ? null : String(row.checkpoint_post_id),
        row.checkpoint_created_at_ms == null
          ? null
          : Number(row.checkpoint_created_at_ms),
        row.next_page == null ? null : Number(row.next_page),
        row.next_since_id == null ? null : String(row.next_since_id),
        row.next_max_id == null ? null : String(row.next_max_id),
        null,
        null,
        row.updated_at || new Date().toISOString()
      );
    }

    for (const row of sourceRows) {
      insert.run(
        Number(row.monitor_id),
        String(row.source_key),
        String(row.flow_id),
        null,
        null,
        null,
        row.next_page == null ? null : Number(row.next_page),
        row.next_since_id == null ? null : String(row.next_since_id),
        row.next_max_id == null ? null : String(row.next_max_id),
        row.next_count == null ? null : String(row.next_count),
        row.next_page_common_ext == null ? null : String(row.next_page_common_ext),
        row.updated_at || new Date().toISOString()
      );
    }

    db.exec(`
      DROP TABLE IF EXISTS superlike_scan_resume;
      ALTER TABLE superlike_scan_resume_unified_tmp
        RENAME TO superlike_scan_resume;
      DROP TABLE IF EXISTS superlike_scan_source_resume;
    `);

    db.exec('COMMIT');

    console.log(
      `[ScanResume] 已统一 Resume 表 | latest=${latestRows.length} | source=${sourceRows.length}`
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

  throw lastError || new Error('Scan Resume 统一迁移失败');
}

ensureUnifiedSchema();

function getScanResume(monitorId) {
  return db.prepare(`
    SELECT
      monitor_id,
      checkpoint_post_id,
      checkpoint_created_at_ms,
      flow_id AS sort_time_flow_id,
      template_url,
      next_page,
      next_since_id,
      next_max_id,
      updated_at
    FROM superlike_scan_resume
    WHERE monitor_id = ?
      AND source_key = ?
  `).get(
    Number(monitorId),
    LATEST_SOURCE_KEY
  ) || null;
}

function saveScanResume(
  monitorId,
  checkpoint,
  sortTimeFlowId,
  templateUrl,
  nextParams
) {
  if (
    !monitorId
    || !sortTimeFlowId
    || !templateUrl
    || !nextParams
    || Number(nextParams.page) < 1
  ) {
    return false;
  }

  db.prepare(`
    INSERT INTO superlike_scan_resume(
      monitor_id,
      source_key,
      flow_id,
      template_url,
      checkpoint_post_id,
      checkpoint_created_at_ms,
      next_page,
      next_since_id,
      next_max_id,
      next_count,
      next_page_common_ext,
      updated_at
    )
    VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,CURRENT_TIMESTAMP)
    ON CONFLICT(monitor_id, source_key)
    DO UPDATE SET
      flow_id = excluded.flow_id,
      template_url = excluded.template_url,
      checkpoint_post_id = excluded.checkpoint_post_id,
      checkpoint_created_at_ms = excluded.checkpoint_created_at_ms,
      next_page = excluded.next_page,
      next_since_id = excluded.next_since_id,
      next_max_id = excluded.next_max_id,
      next_count = NULL,
      next_page_common_ext = NULL,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    Number(monitorId),
    LATEST_SOURCE_KEY,
    String(sortTimeFlowId),
    String(templateUrl),
    checkpoint?.latest_post_id
      ? String(checkpoint.latest_post_id)
      : null,
    Number.isFinite(Number(checkpoint?.latest_created_at_ms))
      ? Number(checkpoint.latest_created_at_ms)
      : null,
    Number(nextParams.page),
    nextParams.since_id == null
      ? null
      : String(nextParams.since_id),
    nextParams.max_id == null
      ? '0'
      : String(nextParams.max_id)
  );

  return true;
}

function clearScanResume(monitorId) {
  const result = db.prepare(`
    DELETE FROM superlike_scan_resume
    WHERE monitor_id = ?
      AND source_key = ?
  `).run(
    Number(monitorId),
    LATEST_SOURCE_KEY
  );

  return Number(result.changes || 0);
}

function getScanSourceResume(monitorId, sourceKey) {
  return db.prepare(`
    SELECT
      monitor_id,
      source_key,
      flow_id,
      next_page,
      next_since_id,
      next_max_id,
      next_count,
      next_page_common_ext,
      updated_at
    FROM superlike_scan_resume
    WHERE monitor_id = ?
      AND source_key = ?
  `).get(
    Number(monitorId),
    String(sourceKey)
  ) || null;
}

function saveScanSourceResume(
  monitorId,
  sourceKey,
  flowId,
  nextParams
) {
  if (
    !monitorId
    || !sourceKey
    || !flowId
    || !nextParams
    || !nextParams.since_id
  ) {
    return false;
  }

  db.prepare(`
    INSERT INTO superlike_scan_resume(
      monitor_id,
      source_key,
      flow_id,
      template_url,
      checkpoint_post_id,
      checkpoint_created_at_ms,
      next_page,
      next_since_id,
      next_max_id,
      next_count,
      next_page_common_ext,
      updated_at
    )
    VALUES(?,?,?,NULL,NULL,NULL,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(monitor_id, source_key)
    DO UPDATE SET
      flow_id = excluded.flow_id,
      template_url = NULL,
      checkpoint_post_id = NULL,
      checkpoint_created_at_ms = NULL,
      next_page = excluded.next_page,
      next_since_id = excluded.next_since_id,
      next_max_id = excluded.next_max_id,
      next_count = excluded.next_count,
      next_page_common_ext = excluded.next_page_common_ext,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    Number(monitorId),
    String(sourceKey),
    String(flowId),
    Number.isFinite(Number(nextParams.page))
      ? Number(nextParams.page)
      : null,
    String(nextParams.since_id),
    nextParams.max_id == null
      ? '0'
      : String(nextParams.max_id),
    nextParams.count == null
      ? '15'
      : String(nextParams.count),
    nextParams.page_common_ext == null
      ? 'topicPrompt:1|page:tag_status_sort=1|hide_page:1'
      : String(nextParams.page_common_ext)
  );

  return true;
}

function clearScanSourceResume(monitorId, sourceKey) {
  const result = db.prepare(`
    DELETE FROM superlike_scan_resume
    WHERE monitor_id = ?
      AND source_key = ?
  `).run(
    Number(monitorId),
    String(sourceKey)
  );

  return Number(result.changes || 0);
}

/*
 * Node preload 先加载本模块，随后 scanner require('./db') 会命中同一份
 * module.exports，因此旧 Scanner 无需改函数签名即可使用统一表。
 */
dbModule.getScanResume = getScanResume;
dbModule.saveScanResume = saveScanResume;
dbModule.clearScanResume = clearScanResume;
dbModule.getScanSourceResume = getScanSourceResume;
dbModule.saveScanSourceResume = saveScanSourceResume;
dbModule.clearScanSourceResume = clearScanSourceResume;
