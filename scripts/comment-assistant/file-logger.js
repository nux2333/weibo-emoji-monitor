'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_LOG_ROOT = path.resolve(ROOT, '..', 'logs', 'comment-assistant-web');

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatDate(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function formatTimestamp(date) {
  return `${formatDate(date)}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function formatLineTime(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function sanitizeComponent(value) {
  return String(value || 'app').replace(/[^\p{L}\p{N}_.-]/gu, '_').slice(0, 80) || 'app';
}

function createFileLogger(component = 'server') {
  const startedAt = new Date();
  const logRoot = process.env.COMMENT_WEB_LOG_ROOT
    ? path.resolve(process.env.COMMENT_WEB_LOG_ROOT)
    : DEFAULT_LOG_ROOT;
  const dateDir = path.join(logRoot, formatDate(startedAt));
  fs.mkdirSync(dateDir, { recursive: true });

  const safeComponent = sanitizeComponent(component);
  const logFile = path.join(dateDir, `${safeComponent}_${formatTimestamp(startedAt)}_${process.pid}.log`);
  const stream = fs.createWriteStream(logFile, { flags: 'a', encoding: 'utf8' });
  const originalConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console)
  };

  function write(level, args) {
    const message = util.format(...args);
    const now = new Date();
    for (const line of String(message).split(/\r?\n/)) {
      stream.write(`[${formatLineTime(now)}] [${level}] [${safeComponent}] ${line}\n`);
    }
  }

  function installConsoleTee() {
    console.log = (...args) => {
      originalConsole.log(...args);
      write('INFO', args);
    };
    console.info = (...args) => {
      originalConsole.info(...args);
      write('INFO', args);
    };
    console.warn = (...args) => {
      originalConsole.warn(...args);
      write('WARN', args);
    };
    console.error = (...args) => {
      originalConsole.error(...args);
      write('ERROR', args);
    };
    console.debug = (...args) => {
      originalConsole.debug(...args);
      write('DEBUG', args);
    };
  }

  return {
    logFile,
    logRoot,
    installConsoleTee,
    info: (...args) => write('INFO', args),
    warn: (...args) => write('WARN', args),
    error: (...args) => write('ERROR', args),
    close: () => new Promise(resolve => stream.end(resolve))
  };
}

module.exports = {
  createFileLogger,
  DEFAULT_LOG_ROOT
};
