'use strict';

const { Client } = require('pg');

const MONTHS = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04',
  May: '05', Jun: '06', Jul: '07', Aug: '08',
  Sep: '09', Oct: '10', Nov: '11', Dec: '12'
};

function pad2(value) {
  return String(value).padStart(2, '0');
}

function validParts(year, month, day, hour, minute, second) {
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);
  const s = Number(second);

  return (
    y >= 2000 && y <= 2100 &&
    mo >= 1 && mo <= 12 &&
    d >= 1 && d <= 31 &&
    h >= 0 && h <= 23 &&
    mi >= 0 && mi <= 59 &&
    s >= 0 && s <= 59
  );
}

function buildDateTime(year, month, day, hour = '00', minute = '00', second = '00') {
  if (!validParts(year, month, day, hour, minute, second)) return null;
  return `${year}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
}

function normalizePostCreatedAt(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;

  // 已经是目标格式；允许尾部毫秒，统一去掉毫秒。
  let m = text.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.\d+)?$/
  );
  if (m) {
    return buildDateTime(m[1], m[2], m[3], m[4], m[5], m[6]);
  }

  // 2026/09/11 18:05:32 / 2026/9/11 18:05:32
  m = text.match(
    /^(\d{4})\/(\d{1,2})\/(\d{1,2})[ T](\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.\d+)?$/
  );
  if (m) {
    return buildDateTime(m[1], m[2], m[3], m[4], m[5], m[6]);
  }

  // 微博原始 created_at：Fri Sep 11 18:05:32 +0800 2026
  // 同时兼容 +08:00 / GMT+0800 / CST 等历史变体。
  m = text.match(
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(?:\+0800|\+08:00|GMT\+0800|CST)\s+(\d{4})$/i
  );
  if (m) {
    const month = MONTHS[
      Object.keys(MONTHS).find(key => key.toLowerCase() === String(m[1]).toLowerCase())
    ];
    if (!month) return null;
    return buildDateTime(m[6], month, m[2], m[3], m[4], m[5]);
  }

  // 有些来源没有星期：Sep 11 18:05:32 +0800 2026
  m = text.match(
    /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(?:\+0800|\+08:00|GMT\+0800|CST)\s+(\d{4})$/i
  );
  if (m) {
    const month = MONTHS[
      Object.keys(MONTHS).find(key => key.toLowerCase() === String(m[1]).toLowerCase())
    ];
    if (!month) return null;
    return buildDateTime(m[6], month, m[2], m[3], m[4], m[5]);
  }

  // ISO 且明确已经带 +08:00 / +0800：只取它表达的北京时间墙上时间，不再做时区换算。
  m = text.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:\+08:00|\+0800)$/
  );
  if (m) {
    return buildDateTime(m[1], m[2], m[3], m[4], m[5], m[6]);
  }

  // 最后兜底：从文本中直接提取 YYYY-MM-DD HH:mm:ss，不做时区运算。
  m = text.match(
    /(20\d{2})[-\/]([01]?\d)[-\/]([0-3]?\d)[ T]([0-2]?\d):([0-5]?\d):([0-5]?\d)/
  );
  if (m) {
    return buildDateTime(m[1], m[2], m[3], m[4], m[5], m[6]);
  }

  return null;
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
      SELECT id, post_id, post_created_at
      FROM superlike_posts
      WHERE post_created_at IS NOT NULL
        AND BTRIM(CAST(post_created_at AS TEXT)) <> ''
      ORDER BY id
    `);

    const pending = [];
    const skippedSamples = [];
    let unchanged = 0;
    let skipped = 0;

    for (const row of result.rows) {
      const before = String(row.post_created_at ?? '').trim();
      const after = normalizePostCreatedAt(before);

      if (!after) {
        skipped += 1;
        if (skippedSamples.length < 30) {
          skippedSamples.push({
            id: row.id,
            post_id: row.post_id,
            value: before
          });
        }
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

    if (skippedSamples.length > 0) {
      console.log('----------------------------------------------');
      console.log(`以下为无法识别样本（最多 ${skippedSamples.length} 条）：`);
      for (const sample of skippedSamples) {
        console.log(
          `id=${sample.id} | post_id=${sample.post_id || '-'} | post_created_at=${JSON.stringify(sample.value)}`
        );
      }
    }

    console.log('==============================================');
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error('[post_created_at] 标准化失败：', error);
  process.exitCode = 1;
});
