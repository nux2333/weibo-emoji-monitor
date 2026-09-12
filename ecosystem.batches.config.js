const path = require('path');

const NODE_EXE = process.execPath;
const PLAYWRIGHT_GUARD = path.join(__dirname, 'src', 'playwright-hardening.js');
const POSTGRES_PRELOAD = path.join(__dirname, 'src', 'postgres-preload.js');
const SKIP_DB_INIT_PRELOAD = path.join(__dirname, 'src', 'skip-db-init-preload.js');

/* 仅供扫描 / 复检 / 补数等后台 Worker 使用。 */
const common = {
  cwd: __dirname,
  interpreter: NODE_EXE,
  node_args: ['--require', SKIP_DB_INIT_PRELOAD, '--require', POSTGRES_PRELOAD, '--require', PLAYWRIGHT_GUARD],
  env: { SKIP_DB_INIT: '1' },
  windowsHide: true,
  autorestart: true,
  restart_delay: 10000,
  exp_backoff_restart_delay: 1000,
  min_uptime: '10s',
  max_restarts: 10,
  kill_timeout: 5000
};

function scanWorker(name, workerOnly) {
  return { ...common, name, script: path.join(__dirname, 'scripts', 'start-superlike-workers.js'), env: { ...common.env, SUPERLIKE_WORKER_ONLY: workerOnly } };
}

const asyncModeNodeArgs = ['--require', SKIP_DB_INIT_PRELOAD, '--require', PLAYWRIGHT_GUARD];

module.exports = {
  apps: [
    scanWorker('scan-fresh-latest', 'fresh-latest'),
    scanWorker('scan-fresh-hot', 'fresh-hot'),
    { ...scanWorker('scan-fresh-superlike', 'fresh-superlike'), env: { ...common.env, SUPERLIKE_WORKER_ONLY: 'fresh-superlike', SUPERLIKE_HEADLESS: '1', SUPERLIKE_SCAN_FORCE_LOCAL: '1' } },
    scanWorker('scan-fresh-yishanshui', 'fresh-yishanshui'),
    scanWorker('scan-fresh-qa', 'fresh-qa'),
    scanWorker('scan-history', 'history'),
    { ...common, name: 'superlike-mode1', script: path.join(__dirname, 'scripts', 'recheck-superlike.js'), env: { ...common.env, SUPERLIKE_RECHECK_MODE: '1' } },
    {
      ...common,
      name: 'superlike-mode2',
      script: path.join(__dirname, 'scripts', 'recheck-superlike-mode2-async.js'),
      node_args: asyncModeNodeArgs,
      env: { ...common.env, SUPERLIKE_RECHECK_MODE: '2', PG_MODE2_POOL_MAX: '6', SUPERLIKE_MODE2_HTTP_CONCURRENCY: '8', SUPERLIKE_MODE2_SESSION_PROXY_RETRIES: '10' }
    },
    {
      ...common,
      name: 'superlike-mode3',
      script: path.join(__dirname, 'scripts', 'recheck-superlike-mode3-async.js'),
      node_args: asyncModeNodeArgs,
      env: { ...common.env, SUPERLIKE_RECHECK_MODE: '3', PG_MODE3_POOL_MAX: '6', SUPERLIKE_MODE3_HTTP_CONCURRENCY: '8', SUPERLIKE_PROFILE_VERIFY_BATCH_SIZE: '300' }
    },
    { ...common, name: 'superlike-mode4', script: path.join(__dirname, 'scripts', 'recheck-superlike.js'), env: { ...common.env, SUPERLIKE_RECHECK_MODE: '4', SUPERLIKE_LIST_NIGHT_INTERVAL_MS: String(3 * 60 * 1000), SUPERLIKE_LIST_BOUNDARY_SAFETY_MAX_PAGES: '150' } },
    { ...common, name: 'superlike-jyz', script: path.join(__dirname, 'scripts', 'backfill-today-jyz.js'), env: { ...common.env, PLAYWRIGHT_GOTO_HARD_TIMEOUT_MS: '10000', PLAYWRIGHT_EVALUATE_HARD_TIMEOUT_MS: '12000', JYZ_BACKFILL_PROXY_RETRIES: '2' } },
    { ...common, name: 'weibo-proxy-pool', script: path.join(__dirname, 'scripts', 'build-weibo-proxy-pool.js') }
  ]
};
