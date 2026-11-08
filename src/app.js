'use strict';

const express = require('express');
const logger = require('./logger');
const { verifySignature } = require('./signature');
const { formatEvent } = require('./formatters');
const { DedupCache } = require('./dedup');

const MAX_BODY_SIZE = '1mb';

/**
 * Build the Express app. Dependencies are injected so tests can run
 * without touching the network.
 *
 * @param {object} deps
 * @param {string} deps.webhookSecret  GitHub webhook secret.
 * @param {{enqueue: Function}} deps.notifier  Discord notifier (queue).
 * @param {DedupCache} [deps.dedup]
 */
function createApp({ webhookSecret, notifier, dedup = new DedupCache() }) {
  const app = express();
  app.disable('x-powered-by');

  // Health check (also used by Render's health probe).
  app.get('/', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'github-discord-activity-logger' });
  });

  app.post(
    '/github-webhook',
    // Keep the raw bytes: the signature must be computed over the exact
    // raw body, not a re-serialization of the parsed JSON.
    express.raw({ type: '*/*', limit: MAX_BODY_SIZE }),
    (req, res) => {
      const delivery = req.get('X-GitHub-Delivery') || 'unknown';
      const event = req.get('X-GitHub-Event');

      if (!verifySignature(req.body, req.get('X-Hub-Signature-256'), webhookSecret)) {
        logger.warn('invalid webhook signature', { delivery, event });
        return res.status(401).json({ error: 'invalid signature' });
      }

      if (!event) {
        return res.status(400).json({ error: 'missing X-GitHub-Event header' });
      }

      let payload;
      try {
        payload = JSON.parse(req.body.toString('utf8'));
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
          throw new Error('payload is not a JSON object');
        }
      } catch {
        logger.warn('malformed webhook payload', { delivery, event });
        return res.status(400).json({ error: 'malformed JSON payload' });
      }

      if (event === 'ping') {
        logger.info('ping received', { delivery, zen: payload.zen });
        return res.status(200).json({ ok: true, pong: true });
      }

      // Redelivery of a webhook we already processed.
      if (dedup.seen(`delivery:${delivery}`)) {
        logger.info('duplicate delivery ignored', { delivery, event });
        return res.status(202).json({ ok: true, duplicate: true });
      }

      let result;
      try {
        result = formatEvent(event, payload);
      } catch (err) {
        logger.error('formatter crashed', { delivery, event, error: err.message });
        return res.status(400).json({ error: 'unprocessable payload' });
      }

      if (result === undefined) {
        logger.info('unsupported event ignored', { delivery, event });
        return res.status(204).end();
      }
      if (result === null) {
        logger.info('ignored action', { delivery, event, action: payload.action });
        return res.status(204).end();
      }

      if (result.dedupKey && dedup.seen(result.dedupKey)) {
        logger.info('semantic duplicate ignored', { delivery, event, key: result.dedupKey });
        return res.status(202).json({ ok: true, duplicate: true });
      }

      const accepted = notifier.enqueue(result.embed, { delivery, event });
      if (!accepted) {
        return res.status(503).json({ error: 'notification queue full' });
      }

      logger.info('event queued for discord', {
        delivery,
        event,
        action: payload.action,
        repo: payload.repository ? payload.repository.full_name : undefined,
      });
      return res.status(202).json({ ok: true });
    }
  );

  // Body too large / other middleware errors.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload too large' });
    }
    logger.error('unhandled request error', { error: err && err.message });
    return res.status(500).json({ error: 'internal error' });
  });

  return app;
}

module.exports = { createApp };
