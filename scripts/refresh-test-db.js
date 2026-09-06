const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PROD_DB =
  process.env.PROD_DB_FILE
  || path.join(DATA_DIR, 'monitor.db');
const TEST_DB =
  process.env.TEST_DB_FILE
  || path.join(DATA_DIR, 'monitor-test.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

if (!fs.existsSync(PROD_DB)) {
  console.error('正式数据库不存在：' + PROD_DB);
  process.exit(1);
}

if (path.resolve(PROD_DB) === path.resolve(TEST_DB)) {
  console.error('测试数据库不能和正式数据库是同一个文件。');
  process.exit(1);
}

for (const suffix of ['', '-wal', '-shm']) {
  const file = TEST_DB + suffix;
  if (fs.existsSync(file)) {
    fs.rmSync(file, { force: true });
  }
}

const escapeSqlString = value =>
  String(value).replaceAll("'", "''");

const db = new DatabaseSync(PROD_DB, {
  readOnly: true
});

try {
  db.exec(
    "VACUUM INTO '" +
    escapeSqlString(TEST_DB) +
    "'"
  );
} finally {
  db.close();
}

console.log('====================================');
console.log('测试数据库快照生成完成');
console.log('正式库：' + PROD_DB);
console.log('测试库：' + TEST_DB);
console.log('====================================');
