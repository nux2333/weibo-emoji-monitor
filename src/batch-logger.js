const fs = require('fs');
const path = require('path');
const util = require('util');


function pad(value) {
  return String(value).padStart(2, '0');
}


function formatTimestamp(date) {
  return (
    date.getFullYear()
    +
    pad(date.getMonth() + 1)
    +
    pad(date.getDate())
    +
    '_'
    +
    pad(date.getHours())
    +
    pad(date.getMinutes())
    +
    pad(date.getSeconds())
  );
}


function formatLogTime(date) {
  return (
    `${date.getFullYear()}-`
    +
    `${pad(date.getMonth() + 1)}-`
    +
    `${pad(date.getDate())} `
    +
    `${pad(date.getHours())}:`
    +
    `${pad(date.getMinutes())}:`
    +
    `${pad(date.getSeconds())}`
  );
}


function createBatchLogger(batchName) {

  const startTime =
    new Date();


  const logDir =
    path.join(
      __dirname,
      '..',
      'logs'
    );


  fs.mkdirSync(
    logDir,
    {
      recursive: true
    }
  );


  const fileName =
    `${batchName}_${formatTimestamp(startTime)}.log`;


  const logFile =
    path.join(
      logDir,
      fileName
    );


  const stream =
    fs.createWriteStream(
      logFile,
      {
        flags: 'a',
        encoding: 'utf8'
      }
    );


  function write(level, args) {

    const message =
      util.format(
        ...args
      );


    const lines =
      String(message)
        .split(/\r?\n/);


    const now =
      formatLogTime(
        new Date()
      );


    for (
      const line
      of lines
    ) {

      stream.write(
        `[${now}] [${level}] ${line}\n`
      );
    }
  }


  /*
   * console 全部改写到文件。
   *
   * 所以后面原来的：
   *
   * console.log(...)
   * console.error(...)
   *
   * 一行都不需要修改。
   */

  console.log =
    (...args) => {
      write(
        'INFO',
        args
      );
    };


  console.info =
    (...args) => {
      write(
        'INFO',
        args
      );
    };


  console.warn =
    (...args) => {
      write(
        'WARN',
        args
      );
    };


  console.error =
    (...args) => {
      write(
        'ERROR',
        args
      );
    };


  console.debug =
    (...args) => {
      write(
        'DEBUG',
        args
      );
    };


  /*
   * Node 自己抛出的未捕获异常也写进去。
   */
  process.on(
    'uncaughtException',
    error => {

      write(
        'ERROR',
        [
          'UncaughtException:',
          error?.stack
          ||
          error
        ]
      );


      stream.end(
        () => {
          process.exit(1);
        }
      );
    }
  );


  process.on(
    'unhandledRejection',
    reason => {

      write(
        'ERROR',
        [
          'UnhandledRejection:',
          reason?.stack
          ||
          reason
        ]
      );
    }
  );


  /*
   * Batch启动信息。
   */
  write(
    'INFO',
    [
      '=============================================='
    ]
  );


  write(
    'INFO',
    [
      `Batch启动：${batchName}`
    ]
  );


  write(
    'INFO',
    [
      `启动时间：${startTime.toLocaleString('zh-CN')}`
    ]
  );


  write(
    'INFO',
    [
      `Log文件：${logFile}`
    ]
  );


  write(
    'INFO',
    [
      '=============================================='
    ]
  );


  return {
    logFile,

    close() {
      return new Promise(
        resolve => {
          stream.end(
            resolve
          );
        }
      );
    }
  };
}


module.exports = {
  createBatchLogger
};