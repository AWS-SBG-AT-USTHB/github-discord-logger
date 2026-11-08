'use strict';

const logger = require('./logger');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * In-process FIFO queue that delivers embeds to a Discord webhook.
 *
 * - The HTTP handler enqueues and returns immediately (GitHub gets a
 *   fast 202); a single worker drains the queue sequentially so
 *   messages keep their order and never race each other.
 * - 429 responses wait for Discord's retry_after and retry the SAME
 *   message (never re-enqueued as a copy, so no duplicates).
 * - 5xx/network errors retry with exponential backoff up to maxRetries,
 *   then the message is dropped and logged.
 * - 4xx (other than 429) means the request itself is bad; it is dropped
 *   immediately since retrying can never succeed.
 */
class DiscordNotifier {
  /**
   * @param {object} opts
   * @param {string} opts.webhookUrl
   * @param {Function} [opts.fetchFn]   injectable for tests
   * @param {number}   [opts.maxRetries]
   * @param {number}   [opts.baseDelayMs]
   * @param {number}   [opts.maxQueueSize]
   */
  constructor({ webhookUrl, fetchFn = fetch, maxRetries = 4, baseDelayMs = 1000, maxQueueSize = 500 }) {
    this.webhookUrl = webhookUrl;
    this.fetchFn = fetchFn;
    this.maxRetries = maxRetries;
    this.baseDelayMs = baseDelayMs;
    this.maxQueueSize = maxQueueSize;
    this.queue = [];
    this.running = false;
    this.draining = null;
  }

  /** Queue an embed for delivery. Returns false if the queue is full. */
  enqueue(embed, meta = {}) {
    if (this.queue.length >= this.maxQueueSize) {
      logger.error('discord queue full, dropping message', { queued: this.queue.length, ...meta });
      return false;
    }
    this.queue.push({ embed, meta });
    this.#run();
    return true;
  }

  /** Resolves once everything currently queued has been processed. */
  async flush() {
    while (this.running || this.queue.length > 0) {
      await (this.draining || sleep(10));
    }
  }

  #run() {
    if (this.running) return;
    this.running = true;
    this.draining = this.#drain().finally(() => {
      this.running = false;
      this.draining = null;
    });
  }

  async #drain() {
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      try {
        await this.#deliver(item);
      } catch (err) {
        logger.error('discord delivery failed permanently', {
          error: err.message,
          ...item.meta,
        });
      }
    }
  }

  async #deliver({ embed, meta }) {
    const body = JSON.stringify({
      embeds: [embed],
      // Never ping anyone from repo content (commit messages, PR titles...).
      allowed_mentions: { parse: [] },
    });

    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this.fetchFn(this.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
      } catch (err) {
        // Network error.
        if (attempt >= this.maxRetries) throw err;
        await sleep(this.baseDelayMs * 2 ** attempt);
        continue;
      }

      if (res.ok) {
        logger.info('discord message delivered', { attempt, ...meta });
        return;
      }

      if (res.status === 429) {
        // Rate limited: honor Discord's retry_after. Does not count
        // against maxRetries — it is throttling, not failure.
        const retryAfterMs = await this.#retryAfterMs(res);
        logger.warn('discord rate limited', { retryAfterMs, ...meta });
        await sleep(retryAfterMs);
        continue;
      }

      if (res.status >= 500) {
        if (attempt >= this.maxRetries) {
          throw new Error(`discord responded ${res.status} after ${attempt + 1} attempts`);
        }
        await sleep(this.baseDelayMs * 2 ** attempt);
        continue;
      }

      // Other 4xx: permanent, do not retry.
      throw new Error(`discord rejected message with status ${res.status}`);
    }
  }

  async #retryAfterMs(res) {
    const header = res.headers && res.headers.get && res.headers.get('retry-after');
    if (header && !Number.isNaN(Number(header))) return Math.ceil(Number(header) * 1000);
    try {
      const data = await res.json();
      if (data && typeof data.retry_after === 'number') return Math.ceil(data.retry_after * 1000);
    } catch {
      /* body not JSON */
    }
    return this.baseDelayMs;
  }
}

module.exports = { DiscordNotifier };
