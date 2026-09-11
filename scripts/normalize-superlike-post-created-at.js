'use strict';

const {
  db,
  initDatabase
} = require('../src/db');
const {
  normalizePostCreatedAt
} = require('../src/superlike/post-save');

function main() {
  initDatabase();

  const rows = db.prepare(`
    SELECT id, post_created_at
    FROM superlike_posts
    WHERE post_created_at IS NOT NULL
      AND TRIM(CAST(post_created_at AS TEXT)) <> ''
  `).all();

  const update = db.prepare(`
    UPDATE superlike_posts
    SET post_created_at = ?
    WHERE id = ?
  `);

  let changed = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const row of rows) {
    const before = String(row.post_created_at || '').trim();
    const after = normalizePostCreatedAt(before);

    if (!after) {
      skipped += 1;
      continue;
    }

    if (after === before) {
      unchanged += 1;
      continue;
    }

    update.run(after, row.id);
    changed += 1;
  }

  console.log('==============================================');
  console.log('SuperLike post_created_at 标准化完成');
  console.log(`总记录：${rows.length}`);
  console.log(`已转换：${changed}`);
  console.log(`原本已标准：${unchanged}`);
  console.log(`无法识别/跳过：${skipped}`);
  console.log('目标格式：YYYY-MM-DD HH:mm:ss（北京时间）');
  console.log('==============================================');
}

try {
  main();
} finally {
  try {
    db.close?.();
  } catch {
    // ignore
  }
}
