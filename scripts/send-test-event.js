'use strict';

/**
 * Sends a realistic, correctly signed sample GitHub "push" event to your
 * locally running server, so you can see a real message appear in Discord.
 *
 * Usage:  node scripts/send-test-event.js [push|pull_request|issues|release|ping]
 */

require('dotenv').config();
const crypto = require('node:crypto');

const SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const PORT = process.env.PORT || 3000;
if (!SECRET || SECRET === 'replace_me') {
  console.error('Set GITHUB_WEBHOOK_SECRET in .env first.');
  process.exit(1);
}

const repository = {
  name: 'demo-repo',
  full_name: 'AWS-SBG-AT-USTHB/demo-repo',
  html_url: 'https://github.com/AWS-SBG-AT-USTHB/demo-repo',
};
const sender = { login: 'test-user', html_url: 'https://github.com/test-user' };

const SAMPLES = {
  ping: { zen: 'Keep it logically awesome.' },
  push: {
    ref: 'refs/heads/main',
    created: false,
    deleted: false,
    compare: `${repository.html_url}/compare/aaa...bbb`,
    commits: [
      {
        id: crypto.randomBytes(20).toString('hex'),
        message: 'feat: test the Discord logger end to end',
        url: `${repository.html_url}/commit/abc1234`,
        author: { username: 'test-user' },
      },
    ],
    repository,
    sender,
  },
  pull_request: {
    action: 'opened',
    pull_request: {
      number: 42,
      title: 'Test PR from send-test-event script',
      html_url: `${repository.html_url}/pull/42`,
      merged: false,
      head: { ref: 'feature/test' },
      base: { ref: 'main' },
    },
    repository,
    sender,
  },
  issues: {
    action: 'opened',
    issue: {
      number: 7,
      title: 'Test issue from send-test-event script',
      html_url: `${repository.html_url}/issues/7`,
    },
    repository,
    sender,
  },
  release: {
    action: 'published',
    release: {
      id: Date.now(), // unique so the release dedup never blocks reruns
      tag_name: 'v0.0.1-test',
      name: 'Test release',
      html_url: `${repository.html_url}/releases/tag/v0.0.1-test`,
      prerelease: false,
    },
    repository,
    sender,
  },
};

const event = process.argv[2] || 'push';
const payload = SAMPLES[event];
if (!payload) {
  console.error(`Unknown event "${event}". Choose one of: ${Object.keys(SAMPLES).join(', ')}`);
  process.exit(1);
}

const body = JSON.stringify(payload);
const signature = 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');

(async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/github-webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-GitHub-Event': event,
      'X-GitHub-Delivery': crypto.randomUUID(), // unique so dedup never blocks reruns
      'X-Hub-Signature-256': signature,
    },
    body,
  });
  console.log(`Sent "${event}" -> HTTP ${res.status}`, await res.text());
  if (res.status === 202) {
    console.log('Queued! Check your Discord channel — the message should appear within a second.');
  }
})().catch((err) => {
  console.error(`Could not reach the server on port ${PORT} — is it running? (npm run dev)`);
  console.error(err.message);
  process.exit(1);
});
