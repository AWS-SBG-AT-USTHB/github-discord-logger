'use strict';

const crypto = require('node:crypto');

/**
 * Verify a GitHub `X-Hub-Signature-256` header against the exact raw
 * request body using HMAC SHA-256 and a constant-time comparison.
 *
 * @param {Buffer} rawBody  Exact raw bytes GitHub sent.
 * @param {string|undefined} signatureHeader  Value of X-Hub-Signature-256.
 * @param {string} secret  Shared webhook secret.
 * @returns {boolean}
 */
function verifySignature(rawBody, signatureHeader, secret) {
  if (!Buffer.isBuffer(rawBody) || !secret) return false;
  if (typeof signatureHeader !== 'string') return false;
  if (!signatureHeader.startsWith('sha256=')) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  const expectedBuf = Buffer.from(`sha256=${expected}`, 'utf8');
  const receivedBuf = Buffer.from(signatureHeader, 'utf8');

  // timingSafeEqual throws on length mismatch; unequal lengths can never
  // match, and length is not secret (the hex digest length is public).
  if (expectedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

module.exports = { verifySignature };
