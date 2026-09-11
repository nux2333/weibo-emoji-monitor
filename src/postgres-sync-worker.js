'use strict';

const { parentPort } = require('worker_threads');
const { Client, types } = require('pg');

types.setTypeParser(1082, value => value);
types.setTypeParser(1114, value => value);
types.setTypeParser(1184, value => value);

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL 未设置，PostgreSQL 无法启动');
}

const client = new Client({
  connectionString: DATABASE_URL,
  application_name: process.env.PGAPPNAME || `weibo-emoji-monitor:${process.pid}`,
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS) || 60000,
  query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS) || 65000,
  keepAlive: true
});

let connected = false;
let connectPromise = null;

async function ensureConnected() {
  if (connected) return;
  if (!connectPromise) {
    connectPromise = client.connect().then(async () => {
      connected = true;
      await client.query("SET TIME ZONE 'Asia/Shanghai'");
      await client.query("SET lock_timeout = '15s'");
      await client.query("SET idle_in_transaction_session_timeout = '60s'");
    });
  }
  return connectPromise;
}

function splitSqlStatements(sql) {
  const out = [];
  let buf = '';
  let quote = null;
  let dollarTag = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (lineComment) {
      buf += ch;
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      buf += ch;
      if (ch === '*' && next === '/') {
        buf += next;
        i++;
        blockComment = false;
      }
      continue;
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        buf += dollarTag;
        i += dollarTag.length - 1;
        dollarTag = null;
      } else {
        buf += ch;
      }
      continue;
    }
    if (quote) {
      buf += ch;
      if (ch === quote) {
        if (next === quote) {
          buf += next;
          i++;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (ch === '-' && next === '-') {
      buf += ch + next;
      i++;
      lineComment = true;
      continue;
    }
    if (ch === '/' && next === '*') {
      buf += ch + next;
      i++;
      blockComment = true;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '$') {
      const m = sql.slice(i).match(/^\$[A-Za-z_0-9]*\$/);
      if (m) {
        dollarTag = m[0];
        buf += dollarTag;
        i += dollarTag.length - 1;
        continue;
      }
    }
    if (ch === ';') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function convertQuestionPlaceholders(sql) {
  let out = '';
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let index = 1;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (lineComment) {
      out += ch;
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      out += ch;
      if (ch === '*' && next === '/') {
        out += next;
        i++;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === quote) {
        if (next === quote) {
          out += next;
          i++;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (ch === '-' && next === '-') {
      out += ch + next;
      i++;
      lineComment = true;
      continue;
    }
    if (ch === '/' && next === '*') {
      out += ch + next;
      i++;
      blockComment = true;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '?') {
      out += `$${index++}`;
      continue;
    }
    out += ch;
  }
  return out;
}

function stripSqlitePragmas(sql) {
  return splitSqlStatements(sql)
    .filter(stmt => !/^PRAGMA\b/i.test(stmt.trim()))
    .join(';\n');
}

function chinaNowTimestampText() {
  return "to_char(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS')";
}

function chinaNowDateText() {
  return "to_char(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')";
}

function translateDateTime(sql) {
  let s = sql;

  /*
   * SQLite CURRENT_TIMESTAMP 的结果本质上是 TEXT（YYYY-MM-DD HH:MM:SS）。
   * 先把业务 SQL 里原生出现的 CURRENT_TIMESTAMP 暂存成 token，避免 PostgreSQL
   * 在 CASE / COALESCE 中把它推断成 timestamptz，和历史 TEXT 字段发生类型冲突。
   * 后续翻译产生的 CURRENT_TIMESTAMP 则继续保留为 PostgreSQL 时间表达式。
   */
  const sqliteCurrentTimestampToken = '__SQLITE_CURRENT_TIMESTAMP_TEXT__';
  s = s.replace(/\bCURRENT_TIMESTAMP\b/gi, sqliteCurrentTimestampToken);

  /*
   * SQLite date()/datetime() 返回文本。业务 SQL 里的日期字段也大多按 TEXT 保存，
   * 所以 PostgreSQL 兼容层必须继续保持该语义，避免 DATE = TEXT 类型冲突。
   */
  s = s.replace(
    /date\(\s*datetime\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*,\s*'\+8 hours'\s*\)\s*\)/gi,
    "to_char(($1)::timestamp + INTERVAL '8 hours', 'YYYY-MM-DD')"
  );

  // SQLite: date(datetime(column))
  // 必须先于普通 datetime(column) 翻译，避免变成 date(to_char(...)) -> DATE = TEXT。
  s = s.replace(
    /date\(\s*datetime\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\)\s*\)/gi,
    "to_char(($1)::timestamp, 'YYYY-MM-DD')"
  );

  // SQLite: datetime('now','+8 hours','start of day','-N day')
  s = s.replace(
    /datetime\(\s*'now'\s*,\s*'\+8 hours'\s*,\s*'start of day'\s*,\s*'-(\d+)\s+days?'\s*\)/gi,
    (_, days) =>
      `to_char(date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai') - INTERVAL '${Number(days)} days', 'YYYY-MM-DD HH24:MI:SS')`
  );

  // SQLite: date/datetime('now','+8 hours','-N day[s]')
  s = s.replace(
    /datetime\(\s*'now'\s*,\s*'\+8 hours'\s*,\s*'-(\d+)\s+days?'\s*\)/gi,
    (_, days) =>
      `to_char((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai') - INTERVAL '${Number(days)} days', 'YYYY-MM-DD HH24:MI:SS')`
  );
  s = s.replace(
    /date\(\s*'now'\s*,\s*'\+8 hours'\s*,\s*'-(\d+)\s+days?'\s*\)/gi,
    (_, days) =>
      `to_char((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai') - INTERVAL '${Number(days)} days', 'YYYY-MM-DD')`
  );

  s = s.replace(
    /datetime\(\s*'now'\s*,\s*'\+8 hours'\s*\)/gi,
    chinaNowTimestampText()
  );
  s = s.replace(
    /date\(\s*'now'\s*,\s*'\+8 hours'\s*\)/gi,
    chinaNowDateText()
  );

  // Dynamic cache window in getRecentSuperLikeProfileStatus().
  s = s.replace(
    /datetime\(\s*'now'\s*,\s*'-'\s*\|\|\s*\?\s*\|\|\s*'\s*minutes'\s*\)/gi,
    "to_char(CURRENT_TIMESTAMP - (? * INTERVAL '1 minute'), 'YYYY-MM-DD HH24:MI:SS')"
  );

  // Legacy migration expressions.
  s = s.replace(
    /datetime\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*,\s*'\+8 hours'\s*\)/gi,
    "to_char(($1)::timestamp + INTERVAL '8 hours', 'YYYY-MM-DD HH24:MI:SS')"
  );
  s = s.replace(
    /date\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*,\s*'\+8 hours'\s*\)/gi,
    "to_char(($1)::timestamp + INTERVAL '8 hours', 'YYYY-MM-DD')"
  );

  s = s.replace(
    /datetime\(\s*'now'\s*\)/gi,
    "to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS')"
  );
  s = s.replace(
    /date\(\s*'now'\s*\)/gi,
    "to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD')"
  );

  // Common simple columns/qualified columns: preserve SQLite TEXT return type.
  s = s.replace(
    /datetime\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\)/gi,
    "to_char(($1)::timestamp, 'YYYY-MM-DD HH24:MI:SS')"
  );
  s = s.replace(
    /date\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\)/gi,
    "to_char(($1)::timestamp, 'YYYY-MM-DD')"
  );

  // Aggregates used by JYZ / OldRefresh ordering.
  s = s.replace(
    /datetime\(\s*(MAX|MIN)\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\)\s*\)/gi,
    "to_char(($1($2))::timestamp, 'YYYY-MM-DD HH24:MI:SS')"
  );
  s = s.replace(
    /date\(\s*(MAX|MIN)\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\)\s*\)/gi,
    "to_char(($1($2))::timestamp, 'YYYY-MM-DD')"
  );

  s = s.replace(
    new RegExp(sqliteCurrentTimestampToken, 'g'),
    chinaNowTimestampText()
  );

  return s;
}

function translateSqliteCatalog(sql, params = []) {
  const normalized = sql.replace(/\s+/g, ' ').trim();
  const pragmaTableInfo = normalized.match(/^PRAGMA\s+table_info\(([^)]+)\)$/i);
  if (pragmaTableInfo) {
    const tableName = pragmaTableInfo[1].replace(/["'`]/g, '').trim();
    return {
      sql: `
        SELECT ordinal_position - 1 AS cid,
               column_name AS name,
               data_type AS type,
               CASE WHEN is_nullable = 'NO' THEN 1 ELSE 0 END AS notnull,
               column_default AS dflt_value,
               CASE WHEN column_name IN (
                 SELECT kcu.column_name
                 FROM information_schema.table_constraints tc
                 JOIN information_schema.key_column_usage kcu
                   ON tc.constraint_name = kcu.constraint_name
                  AND tc.table_schema = kcu.table_schema
                 WHERE tc.constraint_type = 'PRIMARY KEY'
                   AND tc.table_schema = 'public'
                   AND tc.table_name = $1
               ) THEN 1 ELSE 0 END AS pk
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `,
      params: [tableName]
    };
  }

  if (/FROM\s+sqlite_master/i.test(normalized)) {
    if (/SELECT\s+sql\s+FROM\s+sqlite_master/i.test(normalized)) {
      const literal = normalized.match(/name\s*=\s*'([^']+)'/i);
      if (literal) {
        return {
          sql: "SELECT NULL::text AS sql FROM information_schema.tables WHERE table_schema='public' AND table_name=$1 LIMIT 1",
          params: [literal[1]]
        };
      }
    }
    return {
      sql: "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1 LIMIT 1",
      params
    };
  }
  return null;
}

function translateStatement(sql, params = []) {
  const catalog = translateSqliteCatalog(sql, params);
  if (catalog) return catalog;

  let s = String(sql || '').trim();
  if (!s) return { sql: '', params };
  if (/^PRAGMA\b/i.test(s)) return { sql: '', params };

  if (/DELETE\s+FROM\s+superlike_users[\s\S]*\browid\b/i.test(s)) {
    return { sql: '', params: [] };
  }

  s = s.replace(/^BEGIN\s+IMMEDIATE\b/i, 'BEGIN');

  let insertOrIgnore = false;
  if (/^INSERT\s+OR\s+IGNORE\s+INTO/i.test(s)) {
    insertOrIgnore = true;
    s = s.replace(/^INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO');
  }

  s = translateDateTime(s);
  s = s.replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, 'BIGSERIAL PRIMARY KEY');
  s = s.replace(/\bAUTOINCREMENT\b/gi, '');
  s = s.replace(/\bIFNULL\s*\(/gi, 'COALESCE(');
  s = s.replace(/\bCOLLATE\s+NOCASE\b/gi, '');
  s = s.replace(
    /([A-Za-z_][A-Za-z0-9_.]*)\s+GLOB\s+'\[0-9\]\*'/gi,
    "$1 ~ '^[0-9]'"
  );

  if (insertOrIgnore && !/\bON\s+CONFLICT\b/i.test(s)) {
    s += ' ON CONFLICT DO NOTHING';
  }

  s = convertQuestionPlaceholders(s);
  return { sql: s, params };
}

function maybeAddReturningId(sql) {
  if (/\bRETURNING\b/i.test(sql)) return sql;
  const m = sql.match(/^\s*INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)/i);
  if (!m) return sql;
  const idTables = new Set([
    'monitors', 'comments', 'api_responses', 'daily_stats',
    'superlike_posts', 'superlike_black_keywords', 'black_fan_users',
    'superlike_pool_exit_events'
  ]);
  return idTables.has(m[1].toLowerCase()) ? `${sql} RETURNING id` : sql;
}

async function runOne(sql, params, mode) {
  const translated = translateStatement(sql, params);
  if (!translated.sql.trim()) {
    if (mode === 'all') return [];
    if (mode === 'get') return null;
    if (mode === 'run') return { changes: 0, lastInsertRowid: 0 };
    return null;
  }
  const querySql = mode === 'run'
    ? maybeAddReturningId(translated.sql)
    : translated.sql;
  const result = await client.query(querySql, translated.params);
  if (mode === 'all') return result.rows || [];
  if (mode === 'get') return result.rows?.[0] || null;
  if (mode === 'run') {
    return {
      changes: Number(result.rowCount || 0),
      lastInsertRowid: Number(result.rows?.[0]?.id || 0)
    };
  }
  return null;
}

async function runExec(sql) {
  const stripped = stripSqlitePragmas(String(sql || ''));
  const statements = splitSqlStatements(stripped);
  for (const statement of statements) {
    const translated = translateStatement(statement, []);
    if (!translated.sql.trim()) continue;
    await client.query(translated.sql, translated.params);
  }
  return null;
}

function writeResponse(sharedBuffer, payload, isError = false) {
  const control = new Int32Array(sharedBuffer, 0, 4);
  const bytes = new Uint8Array(sharedBuffer, 16);
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  if (encoded.length > bytes.length) {
    const fallback = new TextEncoder().encode(JSON.stringify({
      name: 'PostgresBridgeBufferError',
      message: `PostgreSQL 返回数据过大：${encoded.length} bytes > ${bytes.length} bytes`
    }));
    bytes.set(fallback.subarray(0, bytes.length));
    Atomics.store(control, 1, Math.min(fallback.length, bytes.length));
    Atomics.store(control, 0, -1);
    Atomics.notify(control, 0, 1);
    return;
  }
  bytes.set(encoded);
  Atomics.store(control, 1, encoded.length);
  Atomics.store(control, 0, isError ? -1 : 1);
  Atomics.notify(control, 0, 1);
}

parentPort.on('message', async message => {
  const { sharedBuffer, sql, params = [], mode = 'all', exec = false } = message;
  try {
    await ensureConnected();
    const value = exec ? await runExec(sql) : await runOne(sql, params, mode);
    writeResponse(sharedBuffer, { value }, false);
  } catch (error) {
    writeResponse(sharedBuffer, {
      name: error?.name || 'PostgresError',
      code: error?.code || null,
      message: error?.message || String(error),
      detail: error?.detail || null,
      constraint: error?.constraint || null,
      table: error?.table || null
    }, true);
  }
});

process.on('exit', () => {
  if (connected) client.end().catch(() => {});
});
