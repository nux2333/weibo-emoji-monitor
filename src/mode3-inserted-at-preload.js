'use strict';

/*
 * Mode3 临时源码补丁：
 * 1. “今天入库”按 inserted_at 判断，不做 +8 hours / timezone 二次换算。
 * 2. 每轮打印候选 SQL 以及逐层过滤数量，便于定位 UID=0。
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
      throw new Error(
        '[Mode3日期保护] 找不到旧的 first_seen_at +8 日期条件，拒绝静默启动'
      );
    }
    source = source.replace(oldDate, newDate);

    const oldReturn = '  return db.prepare(`\n    SELECT\n      p.uid,';
    const newReturn = `  const mode3CandidateSql = \`\n    SELECT\n      p.uid,`;
    if (!source.includes(oldReturn)) {
      throw new Error('[Mode3诊断] 找不到候选 SELECT 起点，拒绝静默启动');
    }
    source = source.replace(oldReturn, newReturn);

    const oldEnd = `    LIMIT ?\n  \`).all(\n    monitorId,\n    PROFILE_VERIFY_BATCH_SIZE\n  );\n}`;
    const newEnd = `    LIMIT ?\n  \`;\n\n  console.log('[Mode3 SQL] monitorId=' + monitorId + ' | limit=' + PROFILE_VERIFY_BATCH_SIZE);\n  console.log(mode3CandidateSql.trim());\n\n  const diagnostic = db.prepare(\`\n    SELECT\n      COUNT(*) AS total_rows,\n      COUNT(*) FILTER (WHERE p.monitor_id = ?) AS monitor_rows,\n      COUNT(*) FILTER (WHERE p.monitor_id = ? AND p.uid IS NOT NULL AND p.uid <> '') AS uid_rows,\n      COUNT(*) FILTER (WHERE p.monitor_id = ? AND p.uid IS NOT NULL AND p.uid <> '' AND date(p.inserted_at) = date('now')) AS today_rows,\n      COUNT(*) FILTER (WHERE p.monitor_id = ? AND p.uid IS NOT NULL AND p.uid <> '' AND date(p.inserted_at) = date('now') AND p.experience_7d >= 70) AS today_jyz70_rows,\n      COUNT(DISTINCT CASE WHEN p.monitor_id = ? AND p.uid IS NOT NULL AND p.uid <> '' AND date(p.inserted_at) = date('now') AND p.experience_7d >= 70 THEN p.uid END) AS today_jyz70_uids\n    FROM superlike_posts p\n  \`).get(monitorId, monitorId, monitorId, monitorId, monitorId);\n\n  const excluded = db.prepare(\`\n    SELECT COUNT(DISTINCT p.uid) AS excluded_uids\n    FROM superlike_posts p\n    WHERE p.monitor_id = ?\n      AND p.uid IS NOT NULL\n      AND p.uid <> ''\n      AND date(p.inserted_at) = date('now')\n      AND p.experience_7d >= 70\n      AND EXISTS (SELECT 1 FROM superlike_users su WHERE su.uid = p.uid)\n  \`).get(monitorId);\n\n  console.log('[Mode3 SQL结果] ' + JSON.stringify({ ...diagnostic, ...excluded }));\n\n  const rows = db.prepare(mode3CandidateSql).all(\n    monitorId,\n    PROFILE_VERIFY_BATCH_SIZE\n  );\n  console.log('[Mode3 候选结果] count=' + rows.length + ' | sample=' + JSON.stringify(rows.slice(0, 10)));\n  return rows;\n}`;
    if (!source.includes(oldEnd)) {
      throw new Error('[Mode3诊断] 找不到候选 SELECT 结束位置，拒绝静默启动');
    }
    source = source.replace(oldEnd, newEnd);

    console.log(
      '[Mode3日期保护] inserted_at 无 +8；已启用候选 SQL/逐层过滤结果日志'
    );
    module._compile(source, filename);
    return;
  }

  return originalLoader(module, filename);
};
