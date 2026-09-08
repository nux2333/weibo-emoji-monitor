module.exports = {
  apps: [
    {
      name: 'weibo-server',
      script: 'server.js',
      cwd: __dirname,
      autorestart: true,
      restart_delay: 3000
    }
  ]
};
