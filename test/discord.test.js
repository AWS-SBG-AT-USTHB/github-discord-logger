'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DiscordNotifier } = require('../src/discord');

const URL_ = 'https://discord.test/webhook';
const embed = { title: 'hello', description: 'world' };

function makeFetchScript(responses) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchFn, calls };
}

function res(status, body = '', headers = {}) {
  return new Response(body === '' ? null : body, { status, headers });
}

test('delivers a message and always restricts mentions', async () => {
  const { fetchFn, calls } = makeFetchScript([res(204)]);
  const n = new DiscordNotifier({ webhookUrl: URL_, fetchFn, baseDelayMs: 1 });
  n.enqueue(embed);
  await n.flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, URL_);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.deepEqual(body.embeds, [embed]);
});

test('retries on 429 using retry_after from the JSON body, without duplicating', async () => {
  const { fetchFn, calls } = makeFetchScript([
    res(429, JSON.stringify({ retry_after: 0.01 }), { 'content-type': 'application/json' }),
    res(204),
  ]);
  const n = new DiscordNotifier({ webhookUrl: URL_, fetchFn, baseDelayMs: 1 });
  n.enqueue(embed);
  await n.flush();

  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.body, calls[1].init.body, 'same message retried, not a copy');
});

test('retries on 5xx with backoff and eventually succeeds', async () => {
  const { fetchFn, calls } = makeFetchScript([res(500), res(502), res(204)]);
  const n = new DiscordNotifier({ webhookUrl: URL_, fetchFn, baseDelayMs: 1, maxRetries: 4 });
  n.enqueue(embed);
  await n.flush();
  assert.equal(calls.length, 3);
});

test('gives up after maxRetries on persistent 5xx and moves on', async () => {
  const { fetchFn, calls } = makeFetchScript([res(500), res(500), res(500), res(204)]);
  const n = new DiscordNotifier({ webhookUrl: URL_, fetchFn, baseDelayMs: 1, maxRetries: 2 });
  n.enqueue(embed); // burns 3 attempts (all 500) then drops
  n.enqueue({ title: 'second' }); // gets the 204
  await n.flush();
  assert.equal(calls.length, 4);
  assert.match(calls[3].init.body, /second/);
});

test('does not retry a non-429 4xx', async () => {
  const { fetchFn, calls } = makeFetchScript([res(400, '{"message":"bad embed"}')]);
  const n = new DiscordNotifier({ webhookUrl: URL_, fetchFn, baseDelayMs: 1 });
  n.enqueue(embed);
  await n.flush();
  assert.equal(calls.length, 1);
});

test('retries after a network error', async () => {
  const { fetchFn, calls } = makeFetchScript([new Error('ECONNRESET'), res(204)]);
  const n = new DiscordNotifier({ webhookUrl: URL_, fetchFn, baseDelayMs: 1 });
  n.enqueue(embed);
  await n.flush();
  assert.equal(calls.length, 2);
});

test('rejects new messages when the queue is full', async () => {
  // fetch never resolves, so the first message blocks the worker.
  const fetchFn = () => new Promise(() => {});
  const n = new DiscordNotifier({ webhookUrl: URL_, fetchFn, maxQueueSize: 1 });
  assert.equal(n.enqueue({ title: '1' }), true); // picked up by the worker
  assert.equal(n.enqueue({ title: '2' }), true); // sits in the queue
  assert.equal(n.enqueue({ title: '3' }), false); // queue full
});

test('preserves FIFO order across messages', async () => {
  const { fetchFn, calls } = makeFetchScript([res(204), res(204), res(204)]);
  const n = new DiscordNotifier({ webhookUrl: URL_, fetchFn, baseDelayMs: 1 });
  n.enqueue({ title: 'first' });
  n.enqueue({ title: 'second' });
  n.enqueue({ title: 'third' });
  await n.flush();
  const titles = calls.map((c) => JSON.parse(c.init.body).embeds[0].title);
  assert.deepEqual(titles, ['first', 'second', 'third']);
});
