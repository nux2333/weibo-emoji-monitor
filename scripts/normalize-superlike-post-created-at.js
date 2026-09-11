'use strict';

const { Client } = require('pg');

const MONTHS = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04',
  May: '05', Jun: '06', Jul: '07', Aug: '08',
  Sep: '09', Oct: '10', Nov: '11', Dec: '12'
};

function normalizePostCreatedAt(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
    return text;
  }

  const match = text.match(
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+\+0800\s+(\d{4})$/
  );

  if (!match) return null;

  const [, mon, day, time, year] = match;
  const month = MONTHS[mon];
  if (!month) return null;

  return `${year}-${month}-${String(day).padStart(2, '0')} ${time}`;
}

async function main() {
  const connectionString = String(process.env.DATABASE_URL || '').trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL 未设置');
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    const result = await client.query(`
      SELECT id, post_created_at
      FROM superlike_posts
      WHERE post_created_at IS NOT NULL
        AND BTRIM(CAST(post_created_at AS TEXT)) <> ''
      ORDER BY id
    `);

    const pending = [];
    let unchanged = 0;
    let skipped = 0;

    for (const row of result.rows) {
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

      pending.push([row.id, after]);
    }

    const BATCH_SIZE = 500;
    let changed = 0;

    for (let start = 0; start < pending.length; start += BATCH_SIZE) {
      const batch = pending.slice(start, start + BATCH_SIZE);
      const values = [];
      const params = [];

      batch.forEach(([id, postCreatedAt], index) => {
        const base = index * 2;
        values.push(`($${base + 1}::bigint, $${base + 2}::text)`);
        params.push(id, postCreatedAt);
      });

      await client.query('BEGIN');
      try {
        const updateResult = await client.query(`
          UPDATE superlike_posts AS sp
          SET post_created_at = v.post_created_at
          FROM (VALUES ${values.join(',')}) AS v(id, post_created_at)
          WHERE sp.id = v.id
        `, params);

        await client.query('COMMIT');
        changed += Number(updateResult.rowCount || 0);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }

      console.log(`[post_created_at] ${Math.min(start + batch.length, pending.length)}/${pending.length} 已处理`);
    }

    console.log('==============================================');
    console.log('SuperLike post_created_at 标准化完成');
    console.log(`总记录：${result.rows.length}`);
    console.log(`已转换：${changed}`);
    console.log(`原本已标准：${unchanged}`);
    console.log(`无法识别/跳过：${skipped}`);
    console.log('目标格式：YYYY-MM-DD HH:mm:ss（北京时间，不做时区换算）');
    console.log('==============================================');
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error('[post_created_at] 标准化失败：', error);
  process.exitCode = 1;
});
