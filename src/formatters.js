'use strict';

/**
 * Turn a GitHub webhook event into a compact Discord embed, or return
 * null when the event/action is intentionally ignored (noise control).
 */

const COLORS = {
  push: 0x3b82f6, // blue
  created: 0x22c55e, // green
  closed: 0xef4444, // red
  merged: 0x8b5cf6, // purple
  neutral: 0x64748b, // slate
  release: 0xf59e0b, // amber
};

const MAX_COMMITS_SHOWN = 5;

function truncate(text, max) {
  if (typeof text !== 'string') return '';
  const single = text.split('\n')[0].trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function actorLine(sender) {
  if (!sender || !sender.login) return 'unknown';
  return `[${sender.login}](${sender.html_url || `https://github.com/${sender.login}`})`;
}

function baseEmbed(payload, title, url, description, color) {
  const repo = payload.repository;
  const embed = {
    title: truncate(title, 256),
    color,
    description,
    timestamp: new Date().toISOString(),
    footer: {
      text: repo ? repo.full_name : (payload.organization && payload.organization.login) || 'organization',
    },
  };
  if (url) embed.url = url;
  return embed;
}

function formatPush(payload) {
  const repo = payload.repository;
  if (!repo || typeof payload.ref !== 'string') return null;

  const branch = payload.ref.replace(/^refs\/(heads|tags)\//, '');
  const isTag = payload.ref.startsWith('refs/tags/');

  if (payload.deleted) {
    return baseEmbed(
      payload,
      `🗑️ ${isTag ? 'Tag' : 'Branch'} \`${branch}\` deleted in ${repo.name}`,
      repo.html_url,
      `Deleted by ${actorLine(payload.sender)}`,
      COLORS.closed
    );
  }

  const commits = Array.isArray(payload.commits) ? payload.commits : [];

  if (payload.created && commits.length === 0) {
    return baseEmbed(
      payload,
      `🌱 ${isTag ? 'Tag' : 'Branch'} \`${branch}\` created in ${repo.name}`,
      `${repo.html_url}/tree/${encodeURIComponent(branch)}`,
      `Created by ${actorLine(payload.sender)}`,
      COLORS.created
    );
  }

  // Empty push (e.g. force-push with no new commits): ignore as noise.
  if (commits.length === 0) return null;

  const lines = commits.slice(0, MAX_COMMITS_SHOWN).map((c) => {
    const sha = (c.id || '').slice(0, 7) || '???????';
    const msg = truncate(c.message || '(no message)', 80);
    const author = c.author && c.author.username ? c.author.username : (c.author && c.author.name) || '';
    return `[\`${sha}\`](${c.url}) ${msg}${author ? ` — ${author}` : ''}`;
  });
  if (commits.length > MAX_COMMITS_SHOWN) {
    lines.push(`…and ${commits.length - MAX_COMMITS_SHOWN} more`);
  }

  const count = commits.length;
  return baseEmbed(
    payload,
    `📦 ${count} new commit${count === 1 ? '' : 's'} to \`${branch}\` in ${repo.name}`,
    payload.compare || repo.html_url,
    `Pushed by ${actorLine(payload.sender)}\n${lines.join('\n')}`,
    COLORS.push
  );
}

const PR_ACTIONS = new Set(['opened', 'reopened', 'closed', 'ready_for_review']);

function formatPullRequest(payload) {
  const pr = payload.pull_request;
  const repo = payload.repository;
  if (!pr || !repo || !PR_ACTIONS.has(payload.action)) return null;
  // Ignore noisy draft openings? Keep them — they are still activity; but
  // skip "synchronize"/"edited"/label churn via the PR_ACTIONS allowlist.

  let verb;
  let color;
  if (payload.action === 'closed') {
    if (pr.merged) {
      verb = 'merged';
      color = COLORS.merged;
    } else {
      verb = 'closed';
      color = COLORS.closed;
    }
  } else if (payload.action === 'ready_for_review') {
    verb = 'marked ready for review';
    color = COLORS.created;
  } else {
    verb = payload.action; // opened | reopened
    color = COLORS.created;
  }

  const emoji = verb === 'merged' ? '🟣' : verb === 'closed' ? '🔴' : '🟢';
  const branchInfo = pr.head && pr.base ? `\`${pr.head.ref}\` → \`${pr.base.ref}\`` : '';
  return baseEmbed(
    payload,
    `${emoji} PR #${pr.number} ${verb}: ${truncate(pr.title, 180)}`,
    pr.html_url,
    `${branchInfo ? branchInfo + '\n' : ''}By ${actorLine(payload.sender)}`,
    color
  );
}

function formatPullRequestReview(payload) {
  const review = payload.review;
  const pr = payload.pull_request;
  if (!review || !pr || payload.action !== 'submitted') return null;
  // Commented-only reviews are usually noise; keep approvals and change requests.
  const state = (review.state || '').toLowerCase();
  if (state !== 'approved' && state !== 'changes_requested') return null;

  const label = state === 'approved' ? '✅ approved' : '❌ requested changes on';
  return baseEmbed(
    payload,
    `📝 Review: ${actorNamePlain(payload.sender)} ${label} PR #${pr.number}`,
    review.html_url || pr.html_url,
    `**${truncate(pr.title, 150)}**${review.body ? `\n${truncate(review.body, 200)}` : ''}`,
    state === 'approved' ? COLORS.created : COLORS.closed
  );
}

function actorNamePlain(sender) {
  return sender && sender.login ? sender.login : 'someone';
}

const ISSUE_ACTIONS = new Set(['opened', 'closed', 'reopened', 'assigned', 'labeled']);

function formatIssues(payload) {
  const issue = payload.issue;
  const repo = payload.repository;
  if (!issue || !repo || !ISSUE_ACTIONS.has(payload.action)) return null;
  // Some orgs deliver PRs through the issues event too; skip those to
  // avoid duplicating pull_request notifications.
  if (issue.pull_request) return null;

  let detail = '';
  let emoji = '🟢';
  let color = COLORS.created;
  switch (payload.action) {
    case 'closed':
      emoji = '🔴';
      color = COLORS.closed;
      break;
    case 'assigned':
      emoji = '👤';
      color = COLORS.neutral;
      detail = payload.assignee ? `Assigned to **${payload.assignee.login}**\n` : '';
      break;
    case 'labeled':
      emoji = '🏷️';
      color = COLORS.neutral;
      detail = payload.label ? `Label: **${payload.label.name}**\n` : '';
      break;
    default:
      break;
  }

  return baseEmbed(
    payload,
    `${emoji} Issue #${issue.number} ${payload.action}: ${truncate(issue.title, 180)}`,
    issue.html_url,
    `${detail}By ${actorLine(payload.sender)}`,
    color
  );
}

const RELEASE_ACTIONS = new Set(['published', 'prereleased', 'released']);

function formatRelease(payload) {
  const release = payload.release;
  const repo = payload.repository;
  if (!release || !repo || !RELEASE_ACTIONS.has(payload.action)) return null;

  const kind = release.prerelease ? 'Pre-release' : 'Release';
  return baseEmbed(
    payload,
    `🚀 ${kind} ${release.tag_name || ''} ${payload.action} in ${repo.name}`,
    release.html_url,
    `**${truncate(release.name || release.tag_name || '', 150)}**\nBy ${actorLine(payload.sender)}`,
    COLORS.release
  );
}

function formatWatch(payload) {
  const repo = payload.repository;
  if (!repo || payload.action !== 'started') return null;
  return baseEmbed(
    payload,
    `⭐ ${actorNamePlain(payload.sender)} starred ${repo.name}`,
    repo.html_url,
    `${actorLine(payload.sender)} starred [${repo.full_name}](${repo.html_url})`,
    COLORS.release
  );
}

function formatFork(payload) {
  const repo = payload.repository;
  const forkee = payload.forkee;
  if (!repo || !forkee) return null;
  return baseEmbed(
    payload,
    `🍴 ${actorNamePlain(payload.sender)} forked ${repo.name}`,
    forkee.html_url,
    `${actorLine(payload.sender)} forked [${repo.full_name}](${repo.html_url}) to [${forkee.full_name}](${forkee.html_url})`,
    COLORS.neutral
  );
}

function formatOrganization(payload) {
  const org = payload.organization;
  if (!org) return null;
  const orgUrl = `https://github.com/${org.login}`;
  if (payload.action === 'member_added' && payload.membership && payload.membership.user) {
    const user = payload.membership.user;
    return baseEmbed(
      payload,
      `👋 ${user.login} joined ${org.login}`,
      user.html_url || `https://github.com/${user.login}`,
      `[${user.login}](${user.html_url || `https://github.com/${user.login}`}) is now a member of [${org.login}](${orgUrl})`,
      COLORS.created
    );
  }
  if (payload.action === 'member_invited' && payload.invitation) {
    const who = payload.invitation.login || payload.invitation.email || 'someone';
    return baseEmbed(
      payload,
      `✉️ ${who} was invited to ${org.login}`,
      orgUrl,
      `Invited by ${actorLine(payload.sender)}`,
      COLORS.neutral
    );
  }
  return null;
}

function formatMember(payload) {
  const repo = payload.repository;
  const member = payload.member;
  if (!repo || !member || payload.action !== 'added') return null;
  return baseEmbed(
    payload,
    `🤝 ${member.login} added as collaborator on ${repo.name}`,
    repo.html_url,
    `[${member.login}](${member.html_url || `https://github.com/${member.login}`}) was added by ${actorLine(payload.sender)}`,
    COLORS.created
  );
}

const FORMATTERS = {
  watch: formatWatch,
  fork: formatFork,
  organization: formatOrganization,
  member: formatMember,
  push: formatPush,
  pull_request: formatPullRequest,
  pull_request_review: formatPullRequestReview,
  issues: formatIssues,
  release: formatRelease,
};

/**
 * @returns {{embed: object, dedupKey: string|null}|null}
 *   null  -> event type unsupported or action intentionally ignored.
 *   dedupKey, when set, suppresses semantic duplicates (e.g. a release
 *   firing both "published" and "released").
 */
function formatEvent(eventName, payload) {
  const fn = FORMATTERS[eventName];
  if (!fn) return undefined; // unsupported event type
  const embed = fn(payload);
  if (!embed) return null; // supported event, ignored action/noise

  let dedupKey = null;
  if (eventName === 'release' && payload.release && payload.release.id) {
    // GitHub fires published + released (or published + prereleased) for
    // the same release; collapse them into a single notification.
    dedupKey = `release:${payload.repository.full_name}:${payload.release.id}`;
  }
  return { embed, dedupKey };
}

module.exports = { formatEvent, SUPPORTED_EVENTS: Object.keys(FORMATTERS) };
