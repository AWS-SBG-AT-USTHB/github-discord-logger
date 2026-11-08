'use strict';

require('dotenv').config();

const logger = require('./logger');
const { createApp } = require('./app');
const { DiscordNotifier } = require('./discord');

const PORT = Number(process.env.PORT) || 3000;
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const missing = [];
if (!GITHUB_WEBHOOK_SECRET || GITHUB_WEBHOOK_SECRET === 'replace_me') missing.push('GITHUB_WEBHOOK_SECRET');
if (!DISCORD_WEBHOOK_URL || DISCORD_WEBHOOK_URL === 'replace_me') missing.push('DISCORD_WEBHOOK_URL');
if (missing.length > 0) {
  logger.error('missing required environment variables', { missing });
  process.exit(1);
}

const notifier = new DiscordNotifier({ webhookUrl: DISCORD_WEBHOOK_URL });
const app = createApp({ webhookSecret: GITHUB_WEBHOOK_SECRET, notifier });

const server = app.listen(PORT, () => {
  logger.info('server listening', { port: PORT });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { signal });

  // Stop accepting new connections, then let the Discord queue drain so
  // already-acknowledged events are not lost.
  server.close(async () => {
    try {
      await Promise.race([
        notifier.flush(),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
    } finally {
      logger.info('shutdown complete');
      process.exit(0);
    }
  });

  // Hard stop if connections refuse to close.
  setTimeout(() => {
    logger.warn('forced shutdown after timeout');
    process.exit(1);
  }, 15_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
