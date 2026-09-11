'use strict';

/*
 * 全局启动保护：所有正常服务/批处理默认禁止执行历史重型 initDatabase。
 *
 * 只有显式设置 ALLOW_DB_INIT=1 时才允许 initDatabase 真正执行。
 * 日常脚本通过 --require 加载本 preload，因此即使脚本内部调用
 * initDatabase()，也只会直接返回，不做 DDL / migration / 全表回填。
 */
const fs = require('fs');
const Module = require('module');
const path = require('path');

const DB_FILE = path.resolve(__dirname, 'db.js');
const originalJsLoader = Module._extensions['.js'];
let patched = false;

Module._extensions['.js'] = function skipDbInitLoader(module, filename) {
  if (!patched && path.resolve(filename) === DB_FILE) {
    patched = true;

    const originalSource = fs.readFileSync(filename, 'utf8');
    const marker = 'function initDatabase() {';

    if (!originalSource.includes(marker)) {
      throw new Error('[DB启动保护] 找不到 initDatabase，拒绝静默启动');
    }

    const replacement = `${marker}\n  if (process.env.ALLOW_DB_INIT !== '1') {\n    if (!databaseInitialized) {\n      console.log('[DB启动保护] 默认跳过 initDatabase；仅 ALLOW_DB_INIT=1 时允许执行');\n      databaseInitialized = true;\n    }\n    return;\n  }`;

    const patchedSource = originalSource.replace(marker, replacement);
    module._compile(patchedSource, filename);
    return;
  }

  return originalJsLoader(module, filename);
};

console.log('[DB启动保护] preload 已启用：initDatabase 默认禁用');
