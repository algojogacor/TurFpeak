/**
 * Flash Peak TMS - PM2 Ecosystem Deployment Configuration (Task 6.9)
 * 
 * Optimized for low-memory Linux VM environments (1–2 GB RAM).
 * Runs the TMS bot orchestrator and dedicated evidence media service
 * as isolated, supervised processes with strict memory budgets.
 */

module.exports = {
  apps: [
    {
      name: 'flashpeak-media',
      script: 'node_modules/tsx/dist/cli.mjs',
      args: 'services/flashpeak-media/index.ts',
      cwd: './',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '150M',
      node_args: '--max-old-space-size=128',
      env: {
        NODE_ENV: 'production',
        MEDIA_SERVICE_PORT: 4188,
        MEDIA_STORAGE_PATH: '/var/lib/flashpeak/media',
      },
      error_file: './logs/media-error.log',
      out_file: './logs/media-out.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'flashpeak-bot',
      script: 'node_modules/tsx/dist/cli.mjs',
      args: 'src/index.ts',
      cwd: './',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      node_args: '--max-old-space-size=256',
      env: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
        MEDIA_SERVICE_PORT: 4188,
        MEDIA_SERVICE_URL: 'http://127.0.0.1:4188',
      },
      error_file: './logs/bot-error.log',
      out_file: './logs/bot-out.log',
      merge_logs: true,
      time: true,
      restart_delay: 5000, // Exponential reconnect backoff
    },
  ],
};
