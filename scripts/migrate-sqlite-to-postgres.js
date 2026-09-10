'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const SQLITE_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(ROOT, 'data', 'monitor.db');
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const TRUNCATE_TARGET = String(process.env.PG_MIGRATE_TRUNCATE || '').trim() === '1';
const CHUNK_SIZE = Math.max(10, Number(process.env.PG_MIGRATE_CHUNK_SIZE) || 200);

if (!DATABASE_URL) {
  throw new Error(
    'DATABASE_URL 未设置。例：postgresql://postgres:password@127.0.0.1:5432/weibo_monitor'
  );
}

if (!fs.existsSync(SQLITE_FILE)) {
  throw new Error(`SQLite 文件不存在：${SQLITE_FILE}`);
}

const TABLE_ORDER = [
  'monitors',
  'comments',
  'api_responses',
  'daily_stats',
  'superlike_posts',
  'superlike_list_state',
  'superlike_users',
  'superlike_scan_checkpoint',
  'superlike_scan_resume',
  'superlike_scan_source_resume',
  'superlike_scan_source_checkpoint',
  'superlike_scan_success_state',
  'superlike_pool_exit_events',
  'superlike_pool_exit_daily',
  'superlike_black_keywords',
  'black_fan_users',
  'superlike_old_refresh_state',
  'superlike_daily_excluded_users'
];

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function sourceTableExists(sqlite, tableName) {
  return !!sqlite.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table'
      AND name = ?
    LIMIT 1
  `).get(tableName);
}

function sourceColumns(sqlite, tableName) {
  return sqlite.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`)
    .all()
    .map(row => String(row.name));
}

async function targetColumnMetadata(client, tableName) {
  const result = await client.query(
    `SELECT
       column_name,
       is_nullable,
       column_default
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName]
  );

  return new Map(
    result.rows.map(row => [
      String(row.column_name),
      {
        nullable: String(row.is_nullable) === 'YES',
        defaultValue: row.column_default
      }
    ])
  );
}

async function targetCount(client, tableName) {
  const result = await client.query(
    `SELECT COUNT(*)::bigint AS count FROM ${quoteIdent(tableName)}`
  );
  return Number(result.rows[0]?.count || 0);
}

function normalizeValue(value) {
  if (value === undefined) return null;
  if (Buffer.isBuffer(value)) return value;
  return value;
}

async function insertChunk(client, tableName, columns, columnMetadata, rows) {
  if (!rows.length) return;

  const values = [];
  let paramIndex = 1;
  let defaultedValues = 0;

  const rowSql = rows.map(row => {
    const placeholders = columns.map(column => {
      const value = normalizeValue(row[column]);
      const metadata = columnMetadata.get(column);

      /*
       * SQLite 旧库里部分历史行可能保存了 NULL，
       * 但 PostgreSQL 新 schema 已把该列收紧为 NOT NULL + DEFAULT。
       * 这种情况下不要显式插入 NULL，而是让 PostgreSQL 使用该列默认值。
       *
       * 例：daily_stats.updated_at 旧数据为 NULL，PG 中为
       * NOT NULL DEFAULT CURRENT_TIMESTAMP。
       */
      if (
        value === null
        && metadata
        && metadata.nullable === false
        && metadata.defaultValue !== null
        && metadata.defaultValue !== undefined
      ) {
        defaultedValues++;
        return 'DEFAULT';
      }

      values.push(value);
      return `$${paramIndex++}`;
    });

    return `(${placeholders.join(',')})`;
  });

  const sql = `
    INSERT INTO ${quoteIdent(tableName)}
      (${columns.map(quoteIdent).join(',')})
    VALUES
      ${rowSql.join(',\n      ')}
    ON CONFLICT DO NOTHING
  `;

  await client.query(sql, values);

  if (defaultedValues > 0) {
    console.log(
      `[迁移] ${tableName}: ${defaultedValues} 个旧 NULL 已改用 PostgreSQL DEFAULT`
    );
  }
}

async function resetIdentity(client, tableName) {
  const result = await client.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name=$1
        AND column_name='id'
      LIMIT 1`,
    [tableName]
  );
  if (!result.rowCount) return;

  await client.query(`
    SELECT setval(
      pg_get_serial_sequence('${tableName}', 'id'),
      GREATEST(COALESCE((SELECT MAX(id) FROM ${quoteIdent(tableName)}), 1), 1),
      COALESCE((SELECT MAX(id) FROM ${quoteIdent(tableName)}), 0) > 0
    )
  `).catch(error => {
    // Some tables may not use a sequence; preserving data is more important.
    console.warn(`[迁移] ${tableName} sequence reset skipped: ${error.message}`);
  });
}

function initializeTargetSchema() {
  console.log('[迁移] 初始化 PostgreSQL schema...');
  execFileSync(
    process.execPath,
    [
      '--require',
      path.join(ROOT, 'src', 'postgres-preload.js'),
      path.join(ROOT, 'scripts', 'init-postgres.js')
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL
      },
      stdio: 'inherit'
    }
  );
}

async function main() {
  initializeTargetSchema();

  const sqlite = new DatabaseSync(SQLITE_FILE, { readOnly: true });
  const pg = new Client({ connectionString: DATABASE_URL });
  await pg.connect();
  await pg.query("SET TIME ZONE 'Asia/Shanghai'");

  try {
    const existingTables = TABLE_ORDER.filter(table => sourceTableExists(sqlite, table));

    if (!TRUNCATE_TARGET) {
      for (const tableName of existingTables) {
        const count = await targetCount(pg, tableName);
        if (count > 0) {
          throw new Error(
            `目标 PostgreSQL 表 ${tableName} 已有 ${count} 条数据。` +
            '为了防止误覆盖，本次迁移停止。若确认要清空目标库后重迁，设置 PG_MIGRATE_TRUNCATE=1。'
          );
        }
      }
    }

    await pg.query('BEGIN');

    if (TRUNCATE_TARGET && existingTables.length > 0) {
      console.log('[迁移] 清空 PostgreSQL 目标表...');
      const list = existingTables.map(quoteIdent).join(', ');
      await pg.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    }

    let totalRows = 0;

    for (const tableName of existingTables) {
      const srcColumns = sourceColumns(sqlite, tableName);
      const columnMetadata = await targetColumnMetadata(pg, tableName);
      const columns = srcColumns.filter(column => columnMetadata.has(column));

      if (!columns.length) {
        console.log(`[迁移] ${tableName}: 没有公共字段，跳过`);
        continue;
      }

      const rows = sqlite.prepare(
        `SELECT ${columns.map(quoteIdent).join(',')} FROM ${quoteIdent(tableName)}`
      ).all();

      console.log(
        `[迁移] ${tableName}: ${rows.length} 条 | 字段=${columns.length}`
      );

      for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
        await insertChunk(
          pg,
          tableName,
          columns,
          columnMetadata,
          rows.slice(i, i + CHUNK_SIZE)
        );
      }

      totalRows += rows.length;
      await resetIdentity(pg, tableName);
    }

    await pg.query('COMMIT');

    console.log('==============================================');
    console.log(`[迁移完成] SQLite: ${SQLITE_FILE}`);
    console.log(`[迁移完成] 表数: ${existingTables.length}`);
    console.log(`[迁移完成] 行数: ${totalRows}`);
    console.log('[迁移完成] PostgreSQL 已可供 test 分支使用');
    console.log('==============================================');
  } catch (error) {
    try {
      await pg.query('ROLLBACK');
    } catch {
      // ignore
    }
    throw error;
  } finally {
    sqlite.close();
    await pg.end();
  }
}

main().catch(error => {
  console.error('[迁移失败]', error?.stack || error);
  process.exitCode = 1;
});
