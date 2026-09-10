const path = require('path');

module.exports = {
  apps: [
    {
      name: 'weibo-server',
      script: 'server.js',
      cwd: __dirname,
      interpreter: process.execPath,
      node_args: [
        '--require',
        path.join(__dirname, 'src', 'postgres-preload.js')
      ],
      autorestart: true,
      restart_delay: 3000
    }
  ]
};
