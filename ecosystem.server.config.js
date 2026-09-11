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
const SUPERLIKE_ASYNC_WRITE_PRELOAD = path.join(
  __dirname,
  'src',
  'superlike-async-write-preload.js'
);
const SUPERLIKE_ASYNC_API_PRELOAD = path.join(
  __dirname,
  'src',
  'superlike-async-api-preload.js'
);

/*
 * Web Server 独立 PM2 配置。
 *
 * 与扫描/复检 Batch 完全分离，避免以后调整 Mode1~4、Fresh、History 的
 * restart/preload/watchdog 参数时顺带影响 HTTP Server。
 *
 * SuperLike 页面高频 GET / 写接口 / SSE 已切到原生 async pg.Pool；
 * 其他历史管理 API 暂时仍保留 PostgreSQL compatibility preload，等逐步
 * 迁完后再从 Server 完全删除 POSTGRES_PRELOAD。
 */
module.exports = {
  apps: [
    {
      name: 'weibo-server',
      cwd: __dirname,
      script: path.join(__dirname, 'server.js'),
      interpreter: NODE_EXE,
      node_args: [
        '--require',
        SKIP_DB_INIT_PRELOAD,
        '--require',
        SUPERLIKE_ASYNC_WRITE_PRELOAD,
        '--require',
        SUPERLIKE_ASYNC_API_PRELOAD,
        '--require',
        POSTGRES_PRELOAD,
        '--require',
        PLAYWRIGHT_GUARD
      ],
      env: {
        SKIP_DB_INIT: '1',

        /* SuperLike Web API 原生 PostgreSQL 连接池。 */
        PG_WEB_POOL_MAX: '20',
        PG_WEB_WRITE_POOL_MAX: '10',
        PG_WEB_CONNECT_TIMEOUT_MS: '5000',
        PG_WEB_IDLE_TIMEOUT_MS: '30000',

        /*
         * 旧管理 API 暂时仍使用的 PostgreSQL Bridge 参数。
         * 全部 Web API async 化后删除。
         */
        PG_SYNC_CALL_TIMEOUT_MS: '30000',
        PG_SYNC_BUFFER_BYTES: String(16 * 1024 * 1024)
      },
      windowsHide: true,

      /* Web Server 必须常驻。 */
      autorestart: true,
      restart_delay: 3000,
      exp_backoff_restart_delay: 1000,
      min_uptime: '10s',
      max_restarts: 20,
      kill_timeout: 8000
    }
  ]
};
