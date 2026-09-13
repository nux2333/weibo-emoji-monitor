const fs = require('fs');
const path = require('path');
const util = require('util');

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatTimestamp(date) {
  return (
    date.getFullYear()
    + pad(date.getMonth() + 1)
    + pad(date.getDate())
    + '_'
    + pad(date.getHours())
    + pad(date.getMinutes())
    + pad(date.getSeconds())
  );
}

function formatDateDir(date) {
  return (
    date.getFullYear()
    + pad(date.getMonth() + 1)
    + pad(date.getDate())
  );
}

function formatLogTime(date) {
  return (
    `${date.getFullYear()}-`
    + `${pad(date.getMonth() + 1)}-`
    + `${pad(date.getDate())} `
    + `${pad(date.getHours())}:`
    + `${pad(date.getMinutes())}:`
    + `${pad(date.getSeconds())}`
  );
}

function createBatchLogger(batchName, mode = null) {
  const normalizedMode =
    mode === null
    || mode === undefined
    || String(mode).trim() === ''
      ? ''
      : (
          /^mode\d+$/i.test(String(mode).trim())
            ? String(mode).trim().toLowerCase()
            : `mode${String(mode).trim()}`
        );

  const startTime = new Date();

  let activeDateKey = null;
  let logFile = null;
  let stream = null;
  let closed = false;

  function buildLogFile(date) {
    const logDir = path.join(
      __dirname,
      '..',
      'logs',
      normalizedMode || batchName,
      formatDateDir(date)
    );

    fs.mkdirSync(logDir, { recursive: true });

    const fileName = normalizedMode
      ? `${batchName}_${normalizedMode}_${formatTimestamp(date)}.log`
      : `${batchName}_${formatTimestamp(date)}.log`;

    return path.join(logDir, fileName);
  }

  function openStream(date) {
    activeDateKey = formatDateDir(date);
    logFile = buildLogFile(date);
    stream = fs.createWriteStream(logFile, {
      flags: 'a',
      encoding: 'utf8'
    });
  }

  function rotateIfNeeded(date) {
    if (closed) {
      return false;
    }

    const dateKey = formatDateDir(date);

    if (dateKey === activeDateKey) {
      return false;
    }

    const previousStream = stream;
    const previousLogFile = logFile;

    openStream(date);

    if (previousStream) {
      previousStream.end();
    }

    const now = formatLogTime(date);
    stream.write(
      `[${now}] [INFO] ==============================================\n`
      + `[${now}] [INFO] 日期切换：${activeDateKey}\n`
      + `[${now}] [INFO] 上一个Log文件：${previousLogFile || '-'}\n`
      + `[${now}] [INFO] 新Log文件：${logFile}\n`
      + `[${now}] [INFO] ==============================================\n`
    );

    return true;
  }

  openStream(startTime);

  function write(level, args) {
    const nowDate = new Date();
    rotateIfNeeded(nowDate);

    if (closed || !stream) {
      return;
    }

    const message = util.format(...args);
    const lines = String(message).split(/\r?\n/);
    const now = formatLogTime(nowDate);

    for (const line of lines) {
      stream.write(`[${now}] [${level}] ${line}\n`);
    }
  }

  console.log = (...args) => {
    write('INFO', args);
  };

  console.info = (...args) => {
    write('INFO', args);
  };

  console.warn = (...args) => {
    write('WARN', args);
  };

  console.error = (...args) => {
    write('ERROR', args);
  };

  console.debug = (...args) => {
    write('DEBUG', args);
  };

  process.on('uncaughtException', error => {
    write('ERROR', [
      'UncaughtException:',
      error?.stack || error
    ]);

    const currentStream = stream;
    closed = true;

    if (!currentStream) {
      process.exit(1);
      return;
    }

    currentStream.end(() => {
      process.exit(1);
    });
  });

  process.on('unhandledRejection', reason => {
    write('ERROR', [
      'UnhandledRejection:',
      reason?.stack || reason
    ]);
  });

  write('INFO', [
    '=============================================='
  ]);

  write('INFO', [
    `Batch启动：${batchName}${normalizedMode ? ` | 模式=${normalizedMode}` : ''}`
  ]);

  write('INFO', [
    `启动时间：${startTime.toLocaleString('zh-CN')}`
  ]);

  write('INFO', [
    `Log文件：${logFile}`
  ]);

  write('INFO', [
    '=============================================='
  ]);

  return {
    get logFile() {
      return logFile;
    },

    close() {
      if (closed || !stream) {
        return Promise.resolve();
      }

      closed = true;
      const currentStream = stream;

      return new Promise(resolve => {
        currentStream.end(resolve);
      });
    }
  };
}

module.exports = {
  createBatchLogger
};