'use strict';

/*
 * Global SQLite busy/locked guard.
 *
 * This module is meant to be preloaded with Node --require before src/db.js.
 * It patches node:sqlite synchronously so every process (Fresh/History/Mode/JYZ/Web)
 * gets the same retry behavior without duplicating retry loops in business code.
 */

const SQLITE_HARDENED = Symbol.for('weibo.sqlite.hardened');

const BUSY_TIMEOUT_MS = positiveEnv(
  'SQLITE_BUSY_TIMEOUT_MS',
  30000
);

const RETRY_DELAYS_MS = parseRetryDelays(
  process.env.SQLITE_BUSY_RETRY_DELAYS_MS,
  [200, 500, 1000, 2000, 3000]
);

function positiveEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function parseRetryDelays(raw, fallback) {
  const parsed = String(raw || '')
    .split(',')
    .map(value => Number(value.trim()))
    .filter(value => Number.isFinite(value) && value >= 0)
    .map(value => Math.floor(value));

  return parsed.length > 0 ? parsed : fallback;
}

function isSqliteBusyError(error) {
  const message = String(error?.message || error || '');
  const code = String(error?.code || '');

  return (
    /database is locked/i.test(message)
    || /database table is locked/i.test(message)
    || /SQLITE_BUSY/i.test(message)
    || /SQLITE_LOCKED/i.test(message)
    || /SQLITE_BUSY/i.test(code)
    || /SQLITE_LOCKED/i.test(code)
  );
}

function sleepSync(ms) {
  const delay = Math.max(0, Number(ms) || 0);
  if (delay <= 0) return;

  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, delay);
}

function withSqliteBusyRetrySync(task, label) {
  let lastError = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return task();
    } catch (error) {
      if (!isSqliteBusyError(error)) {
        throw error;
      }

      lastError = error;

      if (attempt >= RETRY_DELAYS_MS.length) {
        console.error(
          `[SQLiteGuard] ${label} 最终仍被锁定 | attempts=${attempt + 1} | ${error?.message || error}`
        );
        throw error;
      }

      const waitMs = RETRY_DELAYS_MS[attempt];

      console.warn(
        `[SQLiteGuard] database locked，等待 ${waitMs}ms 后重试 | ${label} | ${attempt + 1}/${RETRY_DELAYS_MS.length + 1}`
      );

      sleepSync(waitMs);
    }
  }

  throw lastError;
}

function wrapStatement(statement, sqlPreview) {
  if (!statement || statement[SQLITE_HARDENED]) {
    return statement;
  }

  const retryMethods = new Set([
    'run',
    'get',
    'all',
    'iterate'
  ]);

  return new Proxy(statement, {
    get(target, prop, receiver) {
      if (prop === SQLITE_HARDENED) {
        return true;
      }

      const value = Reflect.get(target, prop, receiver);

      if (typeof value !== 'function') {
        return value;
      }

      if (!retryMethods.has(String(prop))) {
        return value.bind(target);
      }

      return (...args) =>
        withSqliteBusyRetrySync(
          () => value.apply(target, args),
          `statement.${String(prop)} ${sqlPreview}`
        );
    }
  });
}

function canSafelyRetryExec(sql) {
  const normalized = String(sql || '')
    .replace(/--.*$/gm, '')
    .trim();

  if (!normalized) return false;

  if (/^(BEGIN(?:\s+IMMEDIATE)?|COMMIT|ROLLBACK|PRAGMA\b)/i.test(normalized)) {
    return true;
  }

  const statements = normalized
    .split(';')
    .map(item => item.trim())
    .filter(Boolean);

  return statements.length <= 1;
}

function installSqliteHardening() {
  let sqlite;

  try {
    sqlite = require('node:sqlite');
  } catch (error) {
    console.warn(
      `[SQLiteGuard] node:sqlite 不可用，跳过共通锁保护: ${error?.message || error}`
    );
    return false;
  }

  const proto = sqlite?.DatabaseSync?.prototype;

  if (!proto || proto[SQLITE_HARDENED]) {
    return true;
  }

  const originalPrepare = proto.prepare;
  const originalExec = proto.exec;

  if (typeof originalPrepare === 'function') {
    proto.prepare = function patchedPrepare(sql, ...rest) {
      const preview = String(sql || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);

      const statement = withSqliteBusyRetrySync(
        () => originalPrepare.call(this, sql, ...rest),
        `prepare ${preview}`
      );

      return wrapStatement(statement, preview);
    };
  }

  if (typeof originalExec === 'function') {
    proto.exec = function patchedExec(sql, ...rest) {
      let actualSql = String(sql || '');

      // src/db.js currently declares 10s. Preload layer raises it for all processes.
      actualSql = actualSql.replace(
        /PRAGMA\s+busy_timeout\s*=\s*\d+\s*;/ig,
        `PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`
      );

      const preview = actualSql
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);

      if (!canSafelyRetryExec(actualSql)) {
        return originalExec.call(this, actualSql, ...rest);
      }

      return withSqliteBusyRetrySync(
        () => originalExec.call(this, actualSql, ...rest),
        `exec ${preview}`
      );
    };
  }

  try {
    Object.defineProperty(proto, SQLITE_HARDENED, {
      value: true,
      configurable: false
    });
  } catch {
    // ignore
  }

  console.log(
    '[SQLiteGuard] 共通锁保护已启用'
    + ` | busy_timeout=${BUSY_TIMEOUT_MS}ms`
    + ` | retry=${RETRY_DELAYS_MS.join('/')}ms`
  );

  return true;
}

installSqliteHardening();

module.exports = {
  BUSY_TIMEOUT_MS,
  RETRY_DELAYS_MS,
  isSqliteBusyError,
  withSqliteBusyRetrySync,
  installSqliteHardening
};
