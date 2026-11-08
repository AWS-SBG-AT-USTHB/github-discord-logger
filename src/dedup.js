'use strict';

/**
 * Fixed-size LRU set used to drop duplicate work:
 *  - redelivered GitHub webhooks (same X-GitHub-Delivery GUID), and
 *  - semantically duplicate events (e.g. release published + released).
 */
class DedupCache {
  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
    this.map = new Map();
  }

  /** Returns true if the key was already seen; records it either way. */
  seen(key) {
    if (this.map.has(key)) {
      // refresh recency
      this.map.delete(key);
      this.map.set(key, true);
      return true;
    }
    this.map.set(key, true);
    if (this.map.size > this.maxSize) {
      this.map.delete(this.map.keys().next().value);
    }
    return false;
  }
}

module.exports = { DedupCache };
