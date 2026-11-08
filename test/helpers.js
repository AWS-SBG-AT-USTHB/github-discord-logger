'use strict';

const crypto = require('node:crypto');
const { createApp } = require('../src/app');

const TEST_SECRET = 'test-secret';

function sign(body, secret = TEST_SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/** Notifier stub that records embeds instead of calling Discord. */
function makeFakeNotifier({ full = false } = {}) {
  return {
    sent: [],
    full,
    enqueue(embed, meta) {
      if (this.full) return false;
      this.sent.push({ embed, meta });
      return true;
    },
  };
}

/** Start the app on an ephemeral port; returns { url, notifier, close }. */
async function startTestServer(overrides = {}) {
  const notifier = overrides.notifier || makeFakeNotifier();
  const app = createApp({ webhookSecret: TEST_SECRET, notifier, ...overrides });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    notifier,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** POST a signed GitHub webhook to the test server. */
async function postEvent(url, event, payload, { secret = TEST_SECRET, delivery, rawBody, signature } = {}) {
  const body = rawBody !== undefined ? rawBody : JSON.stringify(payload);
  return fetch(`${url}/github-webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-GitHub-Event': event,
      'X-GitHub-Delivery': delivery || crypto.randomUUID(),
      'X-Hub-Signature-256': signature !== undefined ? signature : sign(body, secret),
    },
    body,
  });
}

const repository = {
  name: 'demo-repo',
  full_name: 'AWS-SBG-AT-USTHB/demo-repo',
  html_url: 'https://github.com/AWS-SBG-AT-USTHB/demo-repo',
};

const sender = {
  login: 'octocat',
  html_url: 'https://github.com/octocat',
};

module.exports = { TEST_SECRET, sign, makeFakeNotifier, startTestServer, postEvent, repository, sender };
