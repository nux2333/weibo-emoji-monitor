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

module.exports = {
  apps: [
    {
      ...common,
      name: 'weibo-server',
      script: path.join(__dirname, 'server.js')
    },
    {
      ...common,
      name: 'superlike-scan',
      script: path.join(
        __dirname,
        'scripts',
        'start-superlike-workers.js'
      )
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
