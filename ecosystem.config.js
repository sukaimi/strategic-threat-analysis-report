module.exports = {
  apps: [
    {
      name: 'spectre-api',
      script: './api/src/server.js',
      exec_mode: 'fork',
      env: { NODE_ENV: 'production', PORT_API: 3001 },
      instances: 1,
      autorestart: true,
      max_memory_restart: '1G',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
    {
      name: 'spectre-ws',
      script: './ws/src/server.js',
      exec_mode: 'fork',
      env: { NODE_ENV: 'production', PORT_WS: 3002 },
      instances: 1,
      autorestart: false,
      max_memory_restart: '256M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
    // NOTE: spectre-cron removed — server.js is the single owner of all
    // scheduling (collectors, AI analysis, purge, broadcasts) and now also
    // starts the cron scheduler for daily/weekly summary jobs.
  ],
};
