'use strict';

/*
 * Mode3 临时源码补丁：
 * “今天入库”必须按 inserted_at 判断。
 * post_created_at / first_seen_at / inserted_at 均按数据库现值使用，
 * 不做 +8 hours / timezone 二次换算。
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

    const source = fs.readFileSync(filename, 'utf8');
    const oldText = "AND date(p.first_seen_at) = date('now', '+8 hours')";
    const newText = "AND date(p.inserted_at) = date('now')";

    if (!source.includes(oldText)) {
      throw new Error(
        '[Mode3日期保护] 找不到旧的 first_seen_at +8 日期条件，拒绝静默启动'
      );
    }

    const next = source.replace(oldText, newText);
    console.log(
      '[Mode3日期保护] 今天入库条件已改为 inserted_at；不做 +8 hours 转换'
    );
    module._compile(next, filename);
    return;
  }

  return originalLoader(module, filename);
};
