'use strict';

/*
 * Mode3 SQL 诊断 / 日期保护。
 * 不再修改 recheck-superlike.js 源码文本，避免因格式变化导致启动失败。
 * 直接包装 PostgreSQL DatabaseSync.prepare：
 * - 候选 SQL 中 first_seen_at +8 条件改为 inserted_at / date('now')
 * - 打印实际执行 SQL
 * - 打印逐层过滤数量与最终候选样本
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
    const candidate = isMode3CandidateSql(sql);
    const effectiveSql = candidate
      ? normalizeMode3CandidateSql(sql)
      : sql;

    const statement = originalPrepare.call(this, effectiveSql);

    if (!candidate) {
      return statement;
    }

    const database = this;
    const originalAll = statement.all.bind(statement);

    statement.all = function mode3CandidateAll(...params) {
      const monitorId = params[0];
      const limit = params[1];

      console.log('');
      console.log('[Mode3 SQL] monitorId=' + monitorId + ' | limit=' + limit);
      console.log(String(effectiveSql).trim());

      try {
        const diagnostic = originalPrepare.call(database, `
          SELECT
            COUNT(*) AS total_rows,
            COUNT(*) FILTER (
              WHERE p.monitor_id = ?
            ) AS monitor_rows,
            COUNT(*) FILTER (
              WHERE p.monitor_id = ?
                AND p.uid IS NOT NULL
                AND p.uid <> ''
            ) AS uid_rows,
            COUNT(*) FILTER (
              WHERE p.monitor_id = ?
                AND p.uid IS NOT NULL
                AND p.uid <> ''
                AND date(p.inserted_at) = date('now')
            ) AS today_rows,
            COUNT(*) FILTER (
              WHERE p.monitor_id = ?
                AND p.uid IS NOT NULL
                AND p.uid <> ''
                AND date(p.inserted_at) = date('now')
                AND p.experience_7d >= 70
            ) AS today_jyz70_rows,
            COUNT(DISTINCT CASE
              WHEN p.monitor_id = ?
                AND p.uid IS NOT NULL
                AND p.uid <> ''
                AND date(p.inserted_at) = date('now')
                AND p.experience_7d >= 70
              THEN p.uid
            END) AS today_jyz70_uids
          FROM superlike_posts p
        `).get(
          monitorId,
          monitorId,
          monitorId,
          monitorId,
          monitorId
        );

        const excluded = originalPrepare.call(database, `
          SELECT
            COUNT(DISTINCT p.uid) AS excluded_uids
          FROM superlike_posts p
          WHERE p.monitor_id = ?
            AND p.uid IS NOT NULL
            AND p.uid <> ''
            AND date(p.inserted_at) = date('now')
            AND p.experience_7d >= 70
            AND EXISTS (
              SELECT 1
              FROM superlike_users su
              WHERE su.uid = p.uid
            )
        `).get(monitorId);

        console.log(
          '[Mode3 SQL结果] ' +
          JSON.stringify({
            ...diagnostic,
            ...excluded
          })
        );
      } catch (error) {
        console.error(
          '[Mode3 SQL诊断失败] ' +
          (error?.stack || error)
        );
      }

      const rows = originalAll(...params);

      console.log(
        '[Mode3 候选结果] count=' +
        rows.length +
        ' | sample=' +
        JSON.stringify(rows.slice(0, 10))
      );

      return rows;
    };

    return statement;
  };

  console.log(
    '[Mode3日期保护] 已启用 prepare 包装：inserted_at 无 +8 + SQL诊断'
  );
}
