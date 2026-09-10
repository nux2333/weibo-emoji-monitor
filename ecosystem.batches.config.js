const path = require('path');

const NODE_EXE = process.execPath;
const PLAYWRIGHT_GUARD = path.join(
  __dirname,
  'src',
  'playwright-hardening.js'
);
const POSTGRES_PRELOAD = path.join(
  __dirname,
  'src',
  'postgres-preload.js'
);

const common = {
  cwd: __dirname,
  interpreter: NODE_EXE,
  /*
   * test/PG 版统一启用：
   * - PostgreSQL DatabaseSync 兼容层
   * - Playwright 防卡 watchdog
   */
  node_args: [
    '--require',
    POSTGRES_PRELOAD,
    '--require',
    PLAYWRIGHT_GUARD
  ],
  windowsHide: true,
  autorestart: true,
  restart_delay: 10000,
  exp_backoff_restart_delay: 1000,
  min_uptime: '10s',
  max_restarts: 10,
  kill_timeout: 5000
};

function scanWorker(
  name,
  workerOnly
) {
  return {
    ...common,
    name,
    script: path.join(
      __dirname,
      'scripts',
      'start-superlike-workers.js'
    ),
    env: {
      SUPERLIKE_WORKER_ONLY:
        workerOnly
    }
  };
}

module.exports = {
  apps: [
    {
      ...common,
      name: 'weibo-server',
      script: path.join(
        __dirname,
        'server.js'
      )
    },

    /*
     * 五个 Fresh 来源完全独立：
     * 可单独启动，也可同时启动。
     * launcher 内仍保留错峰启动。
     */
    scanWorker(
      'scan-fresh-latest',
      'fresh-latest'
    ),
    scanWorker(
      'scan-fresh-hot',
      'fresh-hot'
    ),
    {
      ...scanWorker(
        'scan-fresh-superlike',
        'fresh-superlike'
      ),
      env: {
        SUPERLIKE_WORKER_ONLY:
          'fresh-superlike',
        SUPERLIKE_HEADLESS:
          '1',
        SUPERLIKE_SCAN_FORCE_LOCAL:
          '1'
      }
    },
    scanWorker(
      'scan-fresh-yishanshui',
      'fresh-yishanshui'
    ),
    scanWorker(
      'scan-fresh-qa',
      'fresh-qa'
    ),

    /*
     * History 独立，不属于五个 Fresh。
     */
    scanWorker(
      'scan-history',
      'history'
    ),

    {
      ...common,
      name: 'superlike-mode1',
      script: path.join(
        __dirname,
        'scripts',
        'recheck-superlike.js'
      ),
      env: {
        SUPERLIKE_RECHECK_MODE: '1'
      }
    },
    {
      ...common,
      name: 'superlike-mode2',
      script: path.join(
        __dirname,
        'scripts',
        'recheck-superlike.js'
      ),
      env: {
        SUPERLIKE_RECHECK_MODE: '2'
      }
    },
    {
      ...common,
      name: 'superlike-mode3',
      script: path.join(
        __dirname,
        'scripts',
        'recheck-superlike.js'
      ),
      env: {
        SUPERLIKE_RECHECK_MODE: '3'
      }
    },
    {
      ...common,
      name: 'superlike-mode4',
      script: path.join(
        __dirname,
        'scripts',
        'recheck-superlike.js'
      ),
      env: {
        SUPERLIKE_RECHECK_MODE: '4'
      }
    },
    {
      ...common,
      name: 'superlike-jyz',
      script: path.join(
        __dirname,
        'scripts',
        'backfill-today-jyz.js'
      ),
      env: {
        /*
         * JYZ 专用收紧 watchdog：
         * 单次 goto 最多10秒、evaluate 最多12秒，最多2轮代理尝试。
         */
        PLAYWRIGHT_GOTO_HARD_TIMEOUT_MS: '10000',
        PLAYWRIGHT_EVALUATE_HARD_TIMEOUT_MS: '12000',
        JYZ_BACKFILL_PROXY_RETRIES: '2'
      }
    },
    {
      ...common,
      name: 'weibo-proxy-pool',
      script: path.join(
        __dirname,
        'scripts',
        'build-weibo-proxy-pool.js'
      )
    }
  ]
};