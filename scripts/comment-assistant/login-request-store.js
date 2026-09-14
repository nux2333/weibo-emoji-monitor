'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'comment-assistant-login-helper.json');
const LOCK_DIR = `${STATE_FILE}.lock`;

fs.mkdirSync(DATA_DIR, { recursive: true });

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

function acquireLock(timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      fs.mkdirSync(LOCK_DIR);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(LOCK_DIR);
        if (Date.now() - stat.mtimeMs > 10000) {
          fs.rmSync(LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      } catch (_) {}
      if (Date.now() >= deadline) throw new Error('登录请求状态文件繁忙，请稍后重试');
      sleepSync(25);
    }
  }
}

function releaseLock() {
  try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch (_) {}
}

function readStateUnsafe() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { helper: null, requests: [] };
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      helper: parsed && typeof parsed.helper === 'object' ? parsed.helper : null,
      requests: Array.isArray(parsed?.requests) ? parsed.requests : []
    };
  } catch (_) {
    return { helper: null, requests: [] };
  }
}

function writeStateUnsafe(state) {
  const temp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(temp, STATE_FILE);
}

function withState(mutator) {
  acquireLock();
  try {
    const state = readStateUnsafe();
    const result = mutator(state);
    state.requests = state.requests
      .filter(item => Date.now() - new Date(item.created_at || 0).getTime() < 24 * 60 * 60 * 1000)
      .slice(-100);
    writeStateUnsafe(state);
    return result;
  } finally {
    releaseLock();
  }
}

function setHelperHeartbeat(extra = {}) {
  return withState(state => {
    state.helper = {
      pid: process.pid,
      session_id: process.env.SESSIONNAME || null,
      updated_at: new Date().toISOString(),
      ...extra
    };
    return state.helper;
  });
}

function getHelperStatus() {
  const state = readStateUnsafe();
  const helper = state.helper || null;
  if (!helper?.updated_at) return { online: false, helper };
  const ageMs = Date.now() - new Date(helper.updated_at).getTime();
  return { online: Number.isFinite(ageMs) && ageMs < 5000, age_ms: ageMs, helper };
}

function enqueueLogin(account) {
  return withState(state => {
    const pending = state.requests.find(item =>
      item.account === account && ['PENDING', 'STARTING', 'OPENED'].includes(item.status));
    if (pending) return pending;
    const request = {
      id: crypto.randomBytes(8).toString('hex'),
      account,
      status: 'PENDING',
      message: '等待桌面 Login Helper',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    state.requests.push(request);
    return request;
  });
}

function listPending() {
  const state = readStateUnsafe();
  return state.requests.filter(item => item.status === 'PENDING');
}

function updateRequest(id, patch) {
  return withState(state => {
    const request = state.requests.find(item => item.id === id);
    if (!request) return null;
    Object.assign(request, patch, { updated_at: new Date().toISOString() });
    return { ...request };
  });
}

function findActiveRequest(account) {
  const state = readStateUnsafe();
  const matches = state.requests.filter(item => item.account === account);
  return matches.reverse().find(item => ['PENDING', 'STARTING', 'OPENED'].includes(item.status)) || null;
}

module.exports = {
  STATE_FILE,
  setHelperHeartbeat,
  getHelperStatus,
  enqueueLogin,
  listPending,
  updateRequest,
  findActiveRequest
};
