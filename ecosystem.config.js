module.exports = {
  apps: [
    {
      name: "Chatbot-Backend",
      cwd: "/root/apps/nexora/chat/backend",
      script: "src/app.js",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      env: {
        NODE_ENV: "production",
        PORT: 4000,
        HOST: "0.0.0.0",
      },
      error_file: "/root/apps/nexora/logs/backend-error.log",
      out_file: "/root/apps/nexora/logs/backend-out.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      restart_delay: 3000,
      max_restarts: 10,
    },
  ],
};
