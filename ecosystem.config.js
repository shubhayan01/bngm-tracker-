// PM2 process config for the JW BNGM Tracker.
//   pm2 start ecosystem.config.js
//   pm2 save && pm2 startup   (so it restarts on server reboot)
//
// IMPORTANT: instances is 1 (fork mode). The store is held in this process's
// memory and flushed to MySQL on each save; running multiple instances would let
// them overwrite each other. One process is plenty for a team of this size.
module.exports = {
  apps: [
    {
      name: 'bngm',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      // Reads DB_*, JWT_SECRET, PORT, etc. from the project's .env file.
      env: {
        NODE_ENV: 'production',
      },
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      time: true,
    },
  ],
};
