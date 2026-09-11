'use strict';

/*
 * 临时启动保护：在 initDatabase 正式拆分完成前，禁止 weibo-server
 * 执行历史的重型初始化 / migration。
 *
 * 只对当前 Node 进程加载的 src/db.js 生效，不修改 db.js 文件本身。
 * 后续 initDatabase 整理完成后删除本 preload 即可。
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

    const replacement = `${marker}\n  if (process.env.SKIP_DB_INIT === '1') {\n    if (!databaseInitialized) {\n      console.log('[DB启动保护] SKIP_DB_INIT=1，已跳过 initDatabase');\n      databaseInitialized = true;\n    }\n    return;\n  }`;

    const patchedSource = originalSource.replace(marker, replacement);
    module._compile(patchedSource, filename);
    return;
  }

  return originalJsLoader(module, filename);
};

console.log('[DB启动保护] preload 已启用');
