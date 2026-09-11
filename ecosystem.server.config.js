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

/*
 * Web Server 独立 PM2 配置。
 *
 * 与扫描/复检 Batch 完全分离，避免以后调整 Mode1~4、Fresh、History 的
 * restart/preload/watchdog 参数时顺带影响 HTTP Server。
 *
 * 当前 server.js 仍有少量历史同步 DB 调用，因此 PostgreSQL compatibility
 * preload 暂时保留；高频 Web API 会逐步迁到原生 async pg.Pool，全部迁完后
 * 再从这里删除 POSTGRES_PRELOAD。
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
        POSTGRES_PRELOAD,
        '--require',
        PLAYWRIGHT_GUARD
      ],
      env: {
        SKIP_DB_INIT: '1',

        /*
         * Server 自己的 PostgreSQL Bridge 参数。
         * 与 Batch 环境变量解耦，后续迁移 async pg.Pool 后可直接删除。
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
