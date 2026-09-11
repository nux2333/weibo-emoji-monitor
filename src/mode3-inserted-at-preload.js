'use strict';

/*
 * Mode3 日期保护。
 * post_created_at / first_seen_at / inserted_at 按数据库现值使用，
 * 不做 +8 hours / timezone 二次换算。
 *
 * 这里仅包装候选 SQL，把旧的 first_seen_at 日期条件统一改为
 * inserted_at / date('now')；不输出 SQL 诊断日志。
 */

if (process.env.SUPERLIKE_RECHECK_MODE === '3') {
  const sqlite = require('node:sqlite');
  const DatabaseSync = sqlite.DatabaseSync;
  const originalPrepare = DatabaseSync.prototype.prepare;

  function isMode3CandidateSql(sql) {
    const text = String(sql || '');
    return (
      /FROM\s+superlike_posts\s+p/i.test(text) &&
      /GROUP\s+BY\s+p\.uid/i.test(text) &&
      /HAVING\s+MAX\(p\.experience_7d\)\s*>=\s*70/i.test(text) &&
      /LIMIT\s+\?/i.test(text)
    );
  }

  function normalizeMode3CandidateSql(sql) {
    let text = String(sql || '');

    text = text.replace(
      /date\(\s*p\.first_seen_at\s*\)\s*=\s*date\(\s*'now'\s*,\s*'\+8 hours'\s*\)/gi,
      "date(p.inserted_at) = date('now')"
    );

    text = text.replace(
      /date\(\s*p\.first_seen_at\s*\)\s*=\s*date\(\s*'now'\s*\)/gi,
      "date(p.inserted_at) = date('now')"
    );

    return text;
  }

  DatabaseSync.prototype.prepare = function mode3Prepare(sql) {
    const effectiveSql = isMode3CandidateSql(sql)
      ? normalizeMode3CandidateSql(sql)
      : sql;

    return originalPrepare.call(this, effectiveSql);
  };

  console.log(
    '[Mode3日期保护] inserted_at 按数据库现值判断当天，不做 +8 hours 转换'
  );
}
