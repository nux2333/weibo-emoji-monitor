'use strict';

/*
 * Mode3 源码补丁：
 * - “今天入库”按 inserted_at 判断，不做 +8 hours / timezone 二次换算。
 * - 打印候选 SQL、逐层过滤数量、最终候选样本。
 */
const fs = require('fs');
const Module = require('module');
const path = require('path');

const TARGET = path.resolve(__dirname, '..', 'scripts', 'recheck-superlike.js');
const originalLoader = Module._extensions['.js'];
let patched = false;

Module._extensions['.js'] = function mode3InsertedAtLoader(module, filename) {
  if (
    !patched &&
    process.env.SUPERLIKE_RECHECK_MODE === '3' &&
    path.resolve(filename) === TARGET
  ) {
    patched = true;

    let source = fs.readFileSync(filename, 'utf8');

    const oldDate = "AND date(p.first_seen_at) = date('now', '+8 hours')";
    const newDate = "AND date(p.inserted_at) = date('now')";
    if (!source.includes(oldDate)) {
      throw new Error('[Mode3日期保护] 找不到旧日期条件，拒绝静默启动');
    }
    source = source.replace(oldDate, newDate);

    const oldBlock = `  return db.prepare(\`\n    SELECT\n      p.uid,\n      MAX(p.username) AS username,\n      COUNT(*) AS post_count,\n      MAX(COALESCE(p.moved_flag, 0)) AS has_moved_post,\n      MAX(p.id) AS latest_id,\n      MIN(p.first_seen_at) AS first_seen_at,\n      MAX(p.profile_last_checked_at) AS profile_last_checked_at,\n      MAX(p.experience_7d) AS experience_7d\n    FROM superlike_posts p\n    WHERE p.monitor_id = ?\n      AND p.uid IS NOT NULL\n      AND p.uid <> ''\n      -- Mode3：只处理今天首次入库的数据（中国时间）\n      AND date(p.inserted_at) = date('now')\n      AND NOT EXISTS (\n        SELECT 1\n        FROM superlike_users su\n        WHERE su.uid = p.uid\n      )\n    GROUP BY p.uid\n    HAVING MAX(p.experience_7d) >= 70\n    ORDER BY\n      MAX(p.experience_7d) DESC,\n      CASE\n        WHEN MAX(p.profile_last_checked_at) IS NULL\n        THEN 0\n        ELSE 1\n      END ASC,\n      datetime(MAX(p.profile_last_checked_at)) ASC,\n      MIN(p.first_seen_at) ASC,\n      MAX(p.id) DESC\n    LIMIT ?\n  \`).all(\n    monitorId,\n    PROFILE_VERIFY_BATCH_SIZE\n  );`;

    const newBlock = `  const mode3CandidateSql = \`\n    SELECT\n      p.uid,\n      MAX(p.username) AS username,\n      COUNT(*) AS post_count,\n      MAX(COALESCE(p.moved_flag, 0)) AS has_moved_post,\n      MAX(p.id) AS latest_id,\n      MIN(p.first_seen_at) AS first_seen_at,\n      MAX(p.profile_last_checked_at) AS profile_last_checked_at,\n      MAX(p.experience_7d) AS experience_7d\n    FROM superlike_posts p\n    WHERE p.monitor_id = ?\n      AND p.uid IS NOT NULL\n      AND p.uid <> ''\n      AND date(p.inserted_at) = date('now')\n      AND NOT EXISTS (\n        SELECT 1\n        FROM superlike_users su\n        WHERE su.uid = p.uid\n      )\n    GROUP BY p.uid\n    HAVING MAX(p.experience_7d) >= 70\n    ORDER BY\n      MAX(p.experience_7d) DESC,\n      CASE\n        WHEN MAX(p.profile_last_checked_at) IS NULL THEN 0\n        ELSE 1\n      END ASC,\n      datetime(MAX(p.profile_last_checked_at)) ASC,\n      MIN(p.first_seen_at) ASC,\n      MAX(p.id) DESC\n    LIMIT ?\n  \`;\n\n  console.log('[Mode3 SQL] monitorId=' + monitorId + ' | limit=' + PROFILE_VERIFY_BATCH_SIZE);\n  console.log(mode3CandidateSql.trim());\n\n  const diagnostic = db.prepare(\`\n    SELECT\n      COUNT(*) AS total_rows,\n      COUNT(*) FILTER (WHERE p.monitor_id = ?) AS monitor_rows,\n      COUNT(*) FILTER (WHERE p.monitor_id = ? AND p.uid IS NOT NULL AND p.uid <> '') AS uid_rows,\n      COUNT(*) FILTER (WHERE p.monitor_id = ? AND p.uid IS NOT NULL AND p.uid <> '' AND date(p.inserted_at) = date('now')) AS today_rows,\n      COUNT(*) FILTER (WHERE p.monitor_id = ? AND p.uid IS NOT NULL AND p.uid <> '' AND date(p.inserted_at) = date('now') AND p.experience_7d >= 70) AS today_jyz70_rows,\n      COUNT(DISTINCT CASE WHEN p.monitor_id = ? AND p.uid IS NOT NULL AND p.uid <> '' AND date(p.inserted_at) = date('now') AND p.experience_7d >= 70 THEN p.uid END) AS today_jyz70_uids\n    FROM superlike_posts p\n  \`).get(monitorId, monitorId, monitorId, monitorId, monitorId);\n\n  const excluded = db.prepare(\`\n    SELECT COUNT(DISTINCT p.uid) AS excluded_uids\n    FROM superlike_posts p\n    WHERE p.monitor_id = ?\n      AND p.uid IS NOT NULL\n      AND p.uid <> ''\n      AND date(p.inserted_at) = date('now')\n      AND p.experience_7d >= 70\n      AND EXISTS (SELECT 1 FROM superlike_users su WHERE su.uid = p.uid)\n  \`).get(monitorId);\n\n  console.log('[Mode3 SQL结果] ' + JSON.stringify({ ...diagnostic, ...excluded }));\n\n  const rows = db.prepare(mode3CandidateSql).all(monitorId, PROFILE_VERIFY_BATCH_SIZE);\n  console.log('[Mode3 候选结果] count=' + rows.length + ' | sample=' + JSON.stringify(rows.slice(0, 10)));\n  return rows;`;

    if (!source.includes(oldBlock)) {
      throw new Error('[Mode3诊断] 找不到候选 SQL 区块，拒绝静默启动');
    }
    source = source.replace(oldBlock, newBlock);

    console.log('[Mode3日期保护] inserted_at 无 +8；已启用候选 SQL/逐层过滤结果日志');
    module._compile(source, filename);
    return;
  }

  return originalLoader(module, filename);
};
