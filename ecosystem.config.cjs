/** PM2: pm2 start ecosystem.config.cjs (из корня проекта, после npm run build). */
module.exports = {
  apps: [
    {
      name: 'vp-bot',
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      time: true,
      max_memory_restart: '200M',
      exp_backoff_restart_delay: 500,
    },
  ],
};
