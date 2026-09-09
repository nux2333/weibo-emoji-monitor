module.exports = {
  apps: [
    {
      name: 'weibo-server',
      script: 'server.js',
      cwd: __dirname,
      interpreter: process.execPath,
      windowsHide: true,
      autorestart: true,
      restart_delay: 3000
    },
    {
      name: 'superlike-scan',
      script: 'scripts/start-superlike-workers.js',
      cwd: __dirname,
      interpreter: process.execPath,
      windowsHide: true,
      autorestart: true,
      restart_delay: 5000
    },
    {
      name: 'superlike-mode4',
      script: 'scripts/recheck-superlike.js',
      cwd: __dirname,
      interpreter: process.execPath,
      windowsHide: true,
      env: {
        SUPERLIKE_RECHECK_MODE: '4'
      },
      autorestart: true,
      restart_delay: 5000
    },
    {
      name: 'superlike-jyz',
      script: 'scripts/backfill-today-jyz.js',
      cwd: __dirname,
      interpreter: process.execPath,
      windowsHide: true,
      autorestart: true,
      restart_delay: 5000
    },
    {
      name: 'weibo-proxy-pool',
      script: 'scripts/build-weibo-proxy-pool.js',
      cwd: __dirname,
      interpreter: process.execPath,
      windowsHide: true,
      autorestart: true,
      restart_delay: 5000
    }
  ]
};
