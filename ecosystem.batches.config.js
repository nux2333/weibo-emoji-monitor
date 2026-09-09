const path = require('path');

const NODE_EXE = process.execPath;

const common = {
  cwd: __dirname,
  interpreter: NODE_EXE,
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
     * 四个 Fresh 来源完全独立：
     * 可单独启动，也可同时启动。
     * launcher 内仍保留 0/3/6/9 秒错峰。
     */
    scanWorker(
      'scan-fresh-latest',
      'fresh-latest'
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
     * History 独立，不属于四个 Fresh。
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
      )
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
