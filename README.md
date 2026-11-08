# GitHub → Discord Activity Logger

A small, production-ready Node.js service that receives **GitHub organization webhooks** for the
`AWS-SBG-AT-USTHB` organization and posts compact, formatted notifications to a Discord channel
through a Discord **incoming webhook**.

## Supported events

| GitHub event | Posted to Discord | Deliberately ignored (noise) |
|---|---|---|
| `push` | New commits (count, hashes, first-line messages, authors, compare link), branch/tag created, branch/tag deleted | Empty pushes (e.g. force-push with no new commits) |
| `pull_request` | opened, reopened, closed, **merged** (distinct from closed), ready_for_review | synchronize, edited, label churn, etc. |
| `pull_request_review` | approved, changes requested (only if you also subscribe to reviews) | comment-only reviews |
| `issues` | opened, closed, reopened, assigned, labeled | everything else; PRs delivered via the issues event (would duplicate PR notifications) |
| `release` | published / prereleased / released — **deduplicated** so one release posts once even though GitHub fires multiple actions | draft edits |
| `ping` | Answered with HTTP 200 (nothing posted) | — |

Other event types are acknowledged with `204 No Content` and ignored.

## Security properties

- Every request to `/github-webhook` must carry a valid `X-Hub-Signature-256` HMAC, verified
  with `crypto.timingSafeEqual` over the **exact raw request body**. Invalid or missing
  signatures get `401` and are never parsed further.
- Request bodies are capped at 1 MB (`413` beyond that).
- Every Discord message is sent with `allowed_mentions: { parse: [] }`, so `@everyone`,
  `@here`, and role/user mentions inside commit messages or titles can **never ping anyone**.
- Secrets live only in environment variables; `.env` is gitignored. Logs are structured JSON
  and never include secrets or full payloads.

## Reliability properties

- Webhook deliveries are acknowledged immediately (`202`); delivery to Discord happens from an
  in-process FIFO queue so GitHub never times out waiting on Discord.
- The queue worker honors Discord `429` rate limits (waits `retry_after`, retries the same
  message), retries `5xx`/network errors with exponential backoff, and never re-enqueues
  duplicates. Non-retryable `4xx` responses are dropped and logged.
- Redelivered webhooks (same `X-GitHub-Delivery` GUID) are detected and skipped.
- Graceful shutdown (SIGTERM/SIGINT): the server stops accepting connections, then drains the
  Discord queue (up to 10 s) before exiting.
- **Trade-off to know about:** the queue is in-memory. If the process crashes or the host
  restarts *while messages are still queued*, those few messages are lost. For a club activity
  logger this is the right simplicity trade-off; if you ever need stronger guarantees, swap the
  queue in `src/discord.js` for a persistent one (e.g. Redis/BullMQ) — the interface is one
  `enqueue()` method.

## Project structure

```
├── src/
│   ├── server.js      # entry point: env validation, listen, graceful shutdown
│   ├── app.js         # Express app: /  (health) and POST /github-webhook
│   ├── signature.js   # X-Hub-Signature-256 verification (HMAC + timingSafeEqual)
│   ├── formatters.js  # GitHub payload -> Discord embed (+ noise filtering)
│   ├── discord.js     # FIFO queue + rate-limit-aware delivery with retries
│   ├── dedup.js       # LRU cache for redeliveries & semantic duplicates
│   └── logger.js      # structured JSON logging
├── test/              # node:test suite (no network; Discord is mocked)
├── .env.example
└── package.json
```

## Local setup

Requires Node.js ≥ 18.17 (uses native `fetch` and `node:test`).

```bash
npm install
cp .env.example .env     # then edit .env with real values
npm run dev              # auto-restarts on changes
# or
npm start
```

Environment variables (see `.env.example`):

| Variable | Description |
|---|---|
| `PORT` | HTTP port (default 3000; Render sets this automatically) |
| `GITHUB_WEBHOOK_SECRET` | Must match the Secret on the GitHub org webhook |
| `DISCORD_WEBHOOK_URL` | Discord incoming webhook URL for the target channel |

The server refuses to start if either secret is missing or still `replace_me`.

## Running tests

```bash
npm test
```

The suite covers signature verification (valid/invalid/tampered/missing/wrong length), ping,
every supported event type, noise filtering, malformed payloads, redelivery dedup, release
dedup, and Discord delivery failures (429 with `retry_after`, 5xx backoff, permanent 4xx,
network errors, FIFO ordering, queue overflow). All Discord requests are mocked — tests never
touch the network.

## Testing a webhook locally (manual)

```bash
BODY='{"zen":"Keep it simple."}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" | awk '{print $2}')
curl -i -X POST http://localhost:3000/github-webhook \
  -H 'content-type: application/json' \
  -H 'X-GitHub-Event: ping' \
  -H 'X-GitHub-Delivery: local-test-1' \
  -H "X-Hub-Signature-256: sha256=$SIG" \
  -d "$BODY"
```

To test against real GitHub deliveries before deploying, expose your local server with a
tunnel (e.g. `ngrok http 3000`) and point the org webhook at the tunnel URL temporarily.

## Configuring the GitHub organization webhook

One **organization-level** webhook covers all current and future repositories in
`AWS-SBG-AT-USTHB` (you must be an org owner):

1. Go to `https://github.com/organizations/AWS-SBG-AT-USTHB/settings/hooks` and open your
   existing webhook (or **Add webhook**).
2. **Payload URL:** `https://<your-service>.onrender.com/github-webhook`
3. **Content type:** either works (the service verifies raw bytes), but
   `application/json` is recommended.
4. **Secret:** the exact value of `GITHUB_WEBHOOK_SECRET`. Generate a strong one with
   `openssl rand -hex 32`.
5. **SSL verification:** keep enabled.
6. **Which events?** Choose **"Let me select individual events"** and tick:
   - **Pushes**
   - **Pull requests**
   - **Issues**
   - **Releases**
   - *(optional)* **Pull request reviews** — adds approval/changes-requested notifications
7. Make sure **Active** is checked and save.

GitHub immediately sends a `ping` — check **Recent Deliveries** on the webhook page for a
green `200`.

## Deploying to Render

1. Push this project to a GitHub repository (it can live inside the org).
2. On [render.com](https://render.com): **New → Web Service**, connect the repository.
3. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Health check path:** `/`
4. **Environment variables** (Render dashboard → Environment):
   - `GITHUB_WEBHOOK_SECRET` = the same secret as on the GitHub webhook
   - `DISCORD_WEBHOOK_URL` = your Discord incoming webhook URL
   - (do **not** set `PORT` — Render injects it)
5. Deploy, then set the GitHub webhook **Payload URL** to
   `https://<service-name>.onrender.com/github-webhook`.

> **Free-tier note:** Render free services sleep after inactivity. GitHub retries are limited,
> so the first event after a long quiet period can be delayed (cold start) or occasionally
> missed. You can redeliver any event from the webhook's **Recent Deliveries** tab; the
> redelivery dedup only suppresses deliveries the service actually processed.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| GitHub delivery shows `401` | Secret mismatch. The env var must byte-for-byte equal the webhook Secret (watch for trailing whitespace/newlines). |
| GitHub delivery shows `400` | Malformed payload or missing `X-GitHub-Event` header — check you're not proxying/modifying the body. |
| Delivery is `202`/`204` but nothing in Discord | `204` = event/action intentionally filtered (see table above). `202` = queued; check service logs for `discord delivery failed` / `discord rejected`. A `404` from Discord means the webhook URL was deleted or is wrong. |
| Duplicate messages | Should not happen — redeliveries and release double-fires are deduplicated. If you see them, check whether two instances of the service are running against the same Discord webhook. |
| `missing required environment variables` on boot | Set `GITHUB_WEBHOOK_SECRET` and `DISCORD_WEBHOOK_URL` (not left as `replace_me`). |
| Timeouts in GitHub Recent Deliveries | Host is cold-starting (free tier) or down — hit `GET /` to verify. The handler itself responds in milliseconds. |

## Security notes

- Rotate the Discord webhook URL (delete + recreate in Discord) and the GitHub secret if
  either ever leaks; both are updated via environment variables only.
- Never commit `.env`. The repo's `.gitignore` already excludes it.
- The service stores nothing and exposes only `/` and `/github-webhook`; everything else is a 404.
