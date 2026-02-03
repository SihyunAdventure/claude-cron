module.exports = {
  apps: [{
    name: 'claude-cron',
    script: 'dist/index.js',
    cwd: '/Users/sihyun/Documents/01_Projects/dev/claude-cron',
    watch: false,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    env: {
      NODE_ENV: 'production'
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
