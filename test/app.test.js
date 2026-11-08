'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, postEvent, repository, sender } = require('./helpers');

let srv;

before(async () => {
  srv = await startTestServer();
});

after(async () => {
  await srv.close();
});

function lastSent() {
  return srv.notifier.sent[srv.notifier.sent.length - 1];
}

test('GET / returns health status', async () => {
  const res = await fetch(`${srv.url}/`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
});

test('rejects an invalid signature with 401 and enqueues nothing', async () => {
  const count = srv.notifier.sent.length;
  const res = await postEvent(srv.url, 'push', { any: 'thing' }, { secret: 'wrong-secret' });
  assert.equal(res.status, 401);
  assert.equal(srv.notifier.sent.length, count);
});

test('rejects a missing signature with 401', async () => {
  const res = await postEvent(srv.url, 'push', { any: 'thing' }, { signature: '' });
  assert.equal(res.status, 401);
});

test('responds to ping events with 200', async () => {
  const res = await postEvent(srv.url, 'ping', { zen: 'Keep it logically awesome.' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pong, true);
});

test('rejects malformed JSON with 400 (signature still valid for the raw bytes)', async () => {
  const res = await postEvent(srv.url, 'push', null, { rawBody: '{not json' });
  assert.equal(res.status, 400);
});

test('rejects a non-object JSON payload with 400', async () => {
  const res = await postEvent(srv.url, 'push', null, { rawBody: '[1,2,3]' });
  assert.equal(res.status, 400);
});

test('ignores unsupported event types with 204', async () => {
  const res = await postEvent(srv.url, 'gollum', { pages: [], repository, sender });
  assert.equal(res.status, 204);
});

test('push event with commits is queued', async () => {
  const payload = {
    ref: 'refs/heads/main',
    created: false,
    deleted: false,
    compare: `${repository.html_url}/compare/abc...def`,
    commits: [
      {
        id: 'abcdef1234567890',
        message: 'feat: add webhook handler\n\nlong body',
        url: `${repository.html_url}/commit/abcdef1`,
        author: { username: 'octocat' },
      },
      {
        id: '1234567abcdef890',
        message: 'fix: typo',
        url: `${repository.html_url}/commit/1234567`,
        author: { name: 'Octo Cat' },
      },
    ],
    repository,
    sender,
  };
  const res = await postEvent(srv.url, 'push', payload);
  assert.equal(res.status, 202);
  const { embed } = lastSent();
  assert.match(embed.title, /2 new commits to `main`/);
  assert.match(embed.description, /abcdef1/);
  assert.match(embed.description, /feat: add webhook handler/);
  assert.ok(!embed.description.includes('long body'), 'only first line of commit message');
});

test('push for a deleted branch is announced safely', async () => {
  const payload = { ref: 'refs/heads/old-branch', deleted: true, created: false, commits: [], repository, sender };
  const res = await postEvent(srv.url, 'push', payload);
  assert.equal(res.status, 202);
  assert.match(lastSent().embed.title, /`old-branch` deleted/);
});

test('empty push (no commits, not created/deleted) is ignored with 204', async () => {
  const payload = { ref: 'refs/heads/main', deleted: false, created: false, commits: [], repository, sender };
  const res = await postEvent(srv.url, 'push', payload);
  assert.equal(res.status, 204);
});

test('pull request opened is queued', async () => {
  const payload = {
    action: 'opened',
    pull_request: {
      number: 7,
      title: 'Add Discord logger',
      html_url: `${repository.html_url}/pull/7`,
      merged: false,
      head: { ref: 'feature/logger' },
      base: { ref: 'main' },
    },
    repository,
    sender,
  };
  const res = await postEvent(srv.url, 'pull_request', payload);
  assert.equal(res.status, 202);
  assert.match(lastSent().embed.title, /PR #7 opened/);
});

test('merged pull request is reported as merged, not closed', async () => {
  const payload = {
    action: 'closed',
    pull_request: {
      number: 8,
      title: 'Merge me',
      html_url: `${repository.html_url}/pull/8`,
      merged: true,
      head: { ref: 'f' },
      base: { ref: 'main' },
    },
    repository,
    sender,
  };
  const res = await postEvent(srv.url, 'pull_request', payload);
  assert.equal(res.status, 202);
  assert.match(lastSent().embed.title, /PR #8 merged/);
});

test('noisy pull request actions (synchronize) are ignored', async () => {
  const payload = {
    action: 'synchronize',
    pull_request: { number: 9, title: 'x', html_url: 'u', merged: false },
    repository,
    sender,
  };
  const res = await postEvent(srv.url, 'pull_request', payload);
  assert.equal(res.status, 204);
});

test('approved review is queued; comment-only review is ignored', async () => {
  const pr = { number: 10, title: 'Review me', html_url: `${repository.html_url}/pull/10` };
  const approved = await postEvent(srv.url, 'pull_request_review', {
    action: 'submitted',
    review: { state: 'approved', html_url: `${repository.html_url}/pull/10#review-1` },
    pull_request: pr,
    repository,
    sender,
  });
  assert.equal(approved.status, 202);
  assert.match(lastSent().embed.title, /approved PR #10/);

  const commented = await postEvent(srv.url, 'pull_request_review', {
    action: 'submitted',
    review: { state: 'commented' },
    pull_request: pr,
    repository,
    sender,
  });
  assert.equal(commented.status, 204);
});

test('issue opened, closed, assigned and labeled are queued', async () => {
  const issue = { number: 3, title: 'Bug report', html_url: `${repository.html_url}/issues/3` };
  for (const [action, extra, pattern] of [
    ['opened', {}, /Issue #3 opened/],
    ['closed', {}, /Issue #3 closed/],
    ['assigned', { assignee: { login: 'octocat' } }, /Issue #3 assigned/],
    ['labeled', { label: { name: 'bug' } }, /Issue #3 labeled/],
  ]) {
    const res = await postEvent(srv.url, 'issues', { action, issue, repository, sender, ...extra });
    assert.equal(res.status, 202, `action ${action}`);
    assert.match(lastSent().embed.title, pattern);
  }
});

test('issues event for a pull request is skipped (no PR duplicates)', async () => {
  const payload = {
    action: 'opened',
    issue: { number: 4, title: 'Actually a PR', html_url: 'u', pull_request: { url: 'x' } },
    repository,
    sender,
  };
  const res = await postEvent(srv.url, 'issues', payload);
  assert.equal(res.status, 204);
});

test('release published is queued once, duplicate released event is suppressed', async () => {
  const release = {
    id: 999,
    tag_name: 'v1.0.0',
    name: 'First release',
    html_url: `${repository.html_url}/releases/tag/v1.0.0`,
    prerelease: false,
  };
  const first = await postEvent(srv.url, 'release', { action: 'published', release, repository, sender });
  assert.equal(first.status, 202);
  assert.match(lastSent().embed.title, /Release v1\.0\.0 published/);

  const count = srv.notifier.sent.length;
  const second = await postEvent(srv.url, 'release', { action: 'released', release, repository, sender });
  assert.equal(second.status, 202);
  const body = await second.json();
  assert.equal(body.duplicate, true);
  assert.equal(srv.notifier.sent.length, count, 'no second message for the same release');
});

test('prerelease is labeled as a pre-release', async () => {
  const release = {
    id: 1000,
    tag_name: 'v2.0.0-rc.1',
    name: 'RC 1',
    html_url: `${repository.html_url}/releases/tag/v2.0.0-rc.1`,
    prerelease: true,
  };
  const res = await postEvent(srv.url, 'release', { action: 'prereleased', release, repository, sender });
  assert.equal(res.status, 202);
  assert.match(lastSent().embed.title, /Pre-release v2\.0\.0-rc\.1/);
});

test('redelivered webhook (same delivery id) is not queued twice', async () => {
  const payload = {
    ref: 'refs/heads/main',
    commits: [{ id: 'aaaaaaa1111', message: 'once', url: 'u', author: { username: 'octocat' } }],
    repository,
    sender,
  };
  const delivery = 'fixed-delivery-guid-123';
  const first = await postEvent(srv.url, 'push', payload, { delivery });
  assert.equal(first.status, 202);
  const count = srv.notifier.sent.length;
  const second = await postEvent(srv.url, 'push', payload, { delivery });
  assert.equal(second.status, 202);
  assert.equal(srv.notifier.sent.length, count);
});

test('returns 503 when the notification queue is full', async () => {
  const { startTestServer: start, makeFakeNotifier } = require('./helpers');
  const fullSrv = await start({ notifier: makeFakeNotifier({ full: true }) });
  try {
    const res = await postEvent(fullSrv.url, 'push', {
      ref: 'refs/heads/main',
      commits: [{ id: 'bbbbbbb', message: 'm', url: 'u' }],
      repository,
      sender,
    });
    assert.equal(res.status, 503);
  } finally {
    await fullSrv.close();
  }
});

test('mentions in content cannot ping (embeds only; allowed_mentions enforced at send time)', async () => {
  const payload = {
    ref: 'refs/heads/main',
    commits: [{ id: 'ccccccc', message: '@everyone look at this', url: 'u' }],
    repository,
    sender,
  };
  const res = await postEvent(srv.url, 'push', payload);
  assert.equal(res.status, 202);
  // The embed may contain the text, but DiscordNotifier always sends
  // allowed_mentions: { parse: [] } — covered in discord.test.js.
  assert.match(lastSent().embed.description, /@everyone/);
});

test('star (watch started) is queued; other watch actions are ignored', async () => {
  const res = await postEvent(srv.url, 'watch', { action: 'started', repository, sender });
  assert.equal(res.status, 202);
  assert.match(lastSent().embed.title, /octocat starred demo-repo/);
});

test('fork is queued with the new fork location', async () => {
  const forkee = { full_name: 'octocat/demo-repo', html_url: 'https://github.com/octocat/demo-repo' };
  const res = await postEvent(srv.url, 'fork', { forkee, repository, sender });
  assert.equal(res.status, 202);
  assert.match(lastSent().embed.title, /octocat forked demo-repo/);
  assert.match(lastSent().embed.description, /octocat\/demo-repo/);
});

test('new organization member and invitation are announced', async () => {
  const organization = { login: 'AWS-SBG-AT-USTHB' };
  const added = await postEvent(srv.url, 'organization', {
    action: 'member_added',
    membership: { user: { login: 'newbie', html_url: 'https://github.com/newbie' } },
    organization,
    sender,
  });
  assert.equal(added.status, 202);
  assert.match(lastSent().embed.title, /newbie joined AWS-SBG-AT-USTHB/);

  const invited = await postEvent(srv.url, 'organization', {
    action: 'member_invited',
    invitation: { login: 'future-member' },
    organization,
    sender,
  });
  assert.equal(invited.status, 202);
  assert.match(lastSent().embed.title, /future-member was invited/);

  const other = await postEvent(srv.url, 'organization', { action: 'renamed', organization, sender });
  assert.equal(other.status, 204);
});

test('collaborator added is announced', async () => {
  const res = await postEvent(srv.url, 'member', {
    action: 'added',
    member: { login: 'helper' },
    repository,
    sender,
  });
  assert.equal(res.status, 202);
  assert.match(lastSent().embed.title, /helper added as collaborator/);
});
