'use strict';

/*
 * PostgreSQL compatibility preload.
 *
 * The project historically uses node:sqlite synchronously throughout the
 * scanner/recheck/server code. Rewriting every call site to async/await in one
 * migration would be high-risk, so this preload replaces DatabaseSync with a
 * synchronous facade backed by a dedicated Worker thread + PostgreSQL client.
 *
 * Existing code can keep using:
 *   const { DatabaseSync } = require('node:sqlite');
 *   db.exec(...)
 *   db.prepare(...).run/get/all/iterate(...)
 * while the actual storage engine is PostgreSQL.
 */

const path = require('path');
const { Worker } = require('worker_threads');

const PATCHED = Symbol.for('weibo.postgres.databaseSync.patched');
const MAX_RESPONSE_BYTES = Math.max(
  8 * 1024 * 1024,
  Number(process.env.PG_SYNC_BUFFER_BYTES) || 64 * 1024 * 1024
);
const CALL_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.PG_SYNC_CALL_TIMEOUT_MS) || 90000
);

function requireDatabaseUrl() {
  const url = String(process.env.DATABASE_URL || '').trim();
  if (!url) {
    throw new Error(
      'PostgreSQL 模式已启用，但 DATABASE_URL 未设置。' +
      '例如：postgresql://postgres:password@127.0.0.1:5432/weibo_monitor'
    );
  }
  return url;
}

/*
 * db.js 以及历史脚本里仍保留了一些 SQLite 专用 PRAGMA。
 * PostgreSQL 不需要、也不认识这些语句。
 *
 * 对 exec() 的多语句文本统一过滤 PRAGMA，其他 SQL 原样保留。
 * 这样不用在每一个 SQLite 时代的调用点单独加 PostgreSQL 判断。
 */
function stripSqlitePragmas(sql) {
  return String(sql || '')
    .split(';')
    .map(statement => statement.trim())
    .filter(Boolean)
    .filter(statement => !/^PRAGMA\b/i.test(statement))
    .join(';\n');
}

class PostgresSyncStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = String(sql || '');
  }

  run(...params) {
    return this.database._request({
      sql: this.sql,
      params,
      mode: 'run'
    });
  }

  get(...params) {
    return this.database._request({
      sql: this.sql,
      params,
      mode: 'get'
    });
  }

  all(...params) {
    return this.database._request({
      sql: this.sql,
      params,
      mode: 'all'
    });
  }

  *iterate(...params) {
    const rows = this.all(...params);
    for (const row of rows) {
      yield row;
    }
  }

  setAllowBareNamedParameters() {
    return this;
  }

  setReadBigInts() {
    return this;
  }
}

class PostgresSyncDatabase {
  constructor(_sqliteFilename, _options = {}) {
    requireDatabaseUrl();

    this.worker = new Worker(
      path.join(__dirname, 'postgres-sync-worker.js'),
      {
        env: {
          ...process.env,
          DATABASE_URL: process.env.DATABASE_URL
        }
      }
    );

    this.closed = false;
    this.worker.unref?.();

    this.worker.on('error', error => {
      console.error('[PostgresBridge] Worker error:', error?.stack || error);
    });

    console.log(
      '[PostgresBridge] PostgreSQL DatabaseSync 兼容层已启用' +
      ` | timeout=${CALL_TIMEOUT_MS}ms` +
      ` | buffer=${Math.round(MAX_RESPONSE_BYTES / 1024 / 1024)}MB`
    );
  }

  prepare(sql) {
    this._assertOpen();
    return new PostgresSyncStatement(this, sql);
  }

  exec(sql) {
    this._assertOpen();

    const postgresSql = stripSqlitePragmas(sql);

    // 整段都是 SQLite PRAGMA 时，在 PostgreSQL 模式直接视为成功。
    if (!postgresSql) {
      return this;
    }

    this._request({
      sql: postgresSql,
      params: [],
      mode: 'run',
      exec: true
    });
    return this;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate().catch(() => {});
  }

  isTransaction() {
    return false;
  }

  _assertOpen() {
    if (this.closed) {
      throw new Error('PostgreSQL database connection is closed');
    }
  }

  _request(payload) {
    this._assertOpen();

    const sharedBuffer = new SharedArrayBuffer(16 + MAX_RESPONSE_BYTES);
    const control = new Int32Array(sharedBuffer, 0, 4);

    this.worker.postMessage({
      ...payload,
      sharedBuffer
    });

    const waitResult = Atomics.wait(
      control,
      0,
      0,
      CALL_TIMEOUT_MS
    );

    if (waitResult === 'timed-out') {
      throw new Error(
        `POSTGRES_SYNC_TIMEOUT: SQL 调用超过 ${CALL_TIMEOUT_MS}ms | ` +
        String(payload.sql || '').replace(/\s+/g, ' ').slice(0, 180)
      );
    }

    const status = Atomics.load(control, 0);
    const length = Atomics.load(control, 1);
    const bytes = new Uint8Array(sharedBuffer, 16, Math.max(0, length));
    const text = new TextDecoder().decode(bytes);

    let response;
    try {
      response = text ? JSON.parse(text) : {};
    } catch (error) {
      throw new Error(`PostgreSQL bridge response parse failed: ${error.message}`);
    }

    if (status < 0) {
      const error = new Error(response.message || 'PostgreSQL query failed');
      error.name = response.name || 'PostgresError';
      if (response.code) error.code = response.code;
      if (response.detail) error.detail = response.detail;
      if (response.constraint) error.constraint = response.constraint;
      if (response.table) error.table = response.table;
      throw error;
    }

    return response.value;
  }
}

function installPostgresCompat() {
  requireDatabaseUrl();

  const sqlite = require('node:sqlite');
  if (sqlite[PATCHED]) return true;

  Object.defineProperty(sqlite, 'DatabaseSync', {
    value: PostgresSyncDatabase,
    configurable: true,
    enumerable: true,
    writable: false
  });

  Object.defineProperty(sqlite, PATCHED, {
    value: true,
    configurable: false
  });

  console.log('[PostgresBridge] node:sqlite.DatabaseSync -> PostgreSQL 已替换');
  return true;
}

installPostgresCompat();

module.exports = {
  PostgresSyncDatabase,
  PostgresSyncStatement,
  installPostgresCompat,
  stripSqlitePragmas
};