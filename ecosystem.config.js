module.exports = {
  apps: [
    {
      name: 'weibo-server',
      script: 'server.js',
      cwd: __dirname,
      autorestart: true,
      restart_delay: 3000
    },
    {
      name: 'superlike-scan',
      script: 'src/superlike-scanner.js',
      cwd: __dirname,
      autorestart: true,
      restart_delay: 5000
    },
    ...['1', '2', '3', '4'].map(mode => ({
      name: 'superlike-mode' + mode,
      script: 'scripts/recheck-superlike.js',
      cwd: __dirname,
      env: {
        SUPERLIKE_RECHECK_MODE: mode
      },
      autorestart: true,
      restart_delay: 5000
    })),
    {
      name: 'weibo-proxy-pool',
      script: 'scripts/build-weibo-proxy-pool.js',
      cwd: __dirname,
      autorestart: false
    }
  ]
};
