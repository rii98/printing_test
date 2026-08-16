// PM2 ecosystem config — copy to ecosystem.config.cjs and fill in your values.
// The real file (ecosystem.config.cjs) is git-ignored because it contains secrets.
module.exports = {
  apps: [{
    name: 'print-agent',
    script: 'src/index.js',
    cwd: __dirname,
    env: {
      SNACKK_URL: 'https://biteo.tech',
      SNACKK_DEVICE_KEY: 'snkp_YOUR_DEVICE_KEY_HERE',   // from snackk Settings → Printer Device
      PRINT_HTTP_PORT: 4010,
      PRINT_DISCOVERY: 'off',
    },
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 2000,
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  }],
};
