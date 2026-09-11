const path = require('path');

module.exports = {
  apps: [
    {
      name: 'weibo-server',
      script: 'server.js',
      cwd: __dirname,
      interpreter: process.execPath,
      env: {
        SKIP_DB_INIT: '1'
      },
      node_args: [
        '--require',
        path.join(__dirname, 'src', 'skip-db-init-preload.js'),
        '--require',
        path.join(__dirname, 'src', 'postgres-preload.js'),
        '--require',
        path.join(__dirname, 'src', 'superlike-pagination-preload.js')
      ],
      autorestart: true,
      restart_delay: 3000
    }
  ]
};
