'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifySignature } = require('../src/signature');

const SECRET = 'top-secret';
const body = Buffer.from(JSON.stringify({ hello: 'world' }));
const validSig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');

test('accepts a valid signature', () => {
  assert.equal(verifySignature(body, validSig, SECRET), true);
});

test('rejects a signature computed with the wrong secret', () => {
  const wrong = 'sha256=' + crypto.createHmac('sha256', 'other').update(body).digest('hex');
  assert.equal(verifySignature(body, wrong, SECRET), false);
});

test('rejects when the body was tampered with', () => {
  const tampered = Buffer.from(JSON.stringify({ hello: 'worlds' }));
  assert.equal(verifySignature(tampered, validSig, SECRET), false);
});

test('rejects a missing signature header', () => {
  assert.equal(verifySignature(body, undefined, SECRET), false);
});

test('rejects a header without the sha256= prefix', () => {
  assert.equal(verifySignature(body, validSig.replace('sha256=', 'sha1='), SECRET), false);
});

test('rejects a signature of the wrong length without throwing', () => {
  assert.equal(verifySignature(body, 'sha256=abc123', SECRET), false);
});

test('rejects garbage hex of the correct length', () => {
  const garbage = 'sha256=' + 'f'.repeat(64);
  assert.equal(verifySignature(body, garbage, SECRET), false);
});

test('rejects when the secret is empty', () => {
  assert.equal(verifySignature(body, validSig, ''), false);
});
