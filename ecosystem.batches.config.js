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
const SKIP_DB_INIT_PRELOAD = path.join(
  __dirname,
  'src',
  'skip-db-init-preload.js'
);
const MODE2_THRESHOLD_PRELOAD = path.join(
  __dirname,
  'src',
  'mode2-dynamic-comment-threshold-preload.js'
);
const MODE3_INSERTED_AT_PRELOAD = path.join(
  __dirname,
  'src',
  'mode3-inserted-at-preload.js'
);

/*
 * 仅供扫描 / 复检 / 补数等后台 Worker 使用。
 * Web Server 已移到 ecosystem.server.config.js，避免 Server 与 Batch
 * 共用 autorestart / watchdog / preload 配置。
 */
const common = {
  cwd: __dirname,
  interpreter: NODE_EXE,
  node_args: [
    '--require',
    SKIP_DB_INIT_PRELOAD,
    '--require',
    POSTGRES_PRELOAD,
    '--require',
    PLAYWRIGHT_GUARD
  ],
  env: {
    SKIP_DB_INIT: '1'
  },
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
      ...common.env,
      SUPERLIKE_WORKER_ONLY:
        workerOnly
    }
  };
}

module.exports = {
  apps: [
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
        ...common.env,
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
        ...common.env,
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
      node_args: [
        ...common.node_args,
        '--require',
        MODE2_THRESHOLD_PRELOAD
      ],
      env: {
        ...common.env,
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
      node_args: [
        ...common.node_args,
        '--require',
        MODE3_INSERTED_AT_PRELOAD
      ],
      env: {
        ...common.env,
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
        ...common.env,
        SUPERLIKE_RECHECK_MODE: '4',
        /* 19:00 起晚高峰：每3分钟扫描一轮。 */
        SUPERLIKE_LIST_NIGHT_INTERVAL_MS: String(3 * 60 * 1000),
        /* 后续轮次命中不了旧边界时，最多扫描150页。 */
        SUPERLIKE_LIST_BOUNDARY_SAFETY_MAX_PAGES: '150'
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
        ...common.env,
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
