module.exports = {
  apps: [
    {
      name: "uploade-backend",
      script: "index.js",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 3,
      restart_delay: 5000,
    },
  ],
}
