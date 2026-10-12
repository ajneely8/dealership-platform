# Environment variables

Validated at startup in `src/env.ts`; the app refuses to start with a clear message if something required is missing or invalid. Template: `.env.example`. Never commit a real `.env`.

`npm run dev` sets everything it needs by itself; a `.env` file is optional there (use it to add `ANTHROPIC_API_KEY`, for example).

## Required

| Variable | Example | Notes |
|---|---|---|
| `SESSION_SECRET` | 96 hex chars | 32+ characters. Signs session cookies. |
| `DATABASE_URL` | `postgres://user:pass@host:5432/dealer_intel` | |
| `REDIS_URL` | `redis://host:6379` | |

## Core

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` enables secure cookies and blocks local storage/targets. |
| `APP_URL` | `http://localhost:5310` | Public URL. Must match what Twilio calls. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | — | Used once by `npm run db:seed` when there are no users. Password 12+ characters. |
| `LOG_LEVEL` | `info` | pino level. |

## Evidence storage

| Variable | Default | Notes |
|---|---|---|
| `STORAGE_DRIVER` | `s3` | `local` stores evidence on the machine running the app (development and single-workstation use); hosted deployments should use `s3`. |
| `STORAGE_LOCAL_DIR` | `.data/evidence` | Used by the local driver. |
| `S3_ENDPOINT` | — | e.g. `http://minio:9000`. Leave empty for AWS S3. |
| `S3_REGION` | `us-east-1` | |
| `S3_BUCKET` | `dealer-intel-evidence` | Created on first use if missing. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | — | Required when `STORAGE_DRIVER=s3`. |
| `S3_FORCE_PATH_STYLE` | `true` | `true` for MinIO; `false` for AWS. |

## AI (optional)

| Variable | Default | Notes |
|---|---|---|
| `AI_PROVIDER` | `none` | `anthropic` or `none`. Can be overridden in Settings. |
| `AI_MODEL` | `claude-opus-5-5` | Can be overridden in Settings. |
| `ANTHROPIC_API_KEY` | — | Server-side only. |

Per-job AI limits (`maxAIRequestsPerJob`, `maxAITokensPerJob`) are admin settings, not env vars.

## Webhooks

| Variable | Notes |
|---|---|
| `WEBHOOK_SECRET` | Expected in the `x-webhook-secret` header. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | — | Phone checks. Without all three the phone check reports "not configured". |
| `TWILIO_AUTH_TOKEN` | Enables `X-Twilio-Signature` verification. |

With neither set, webhook endpoints return 503.

## Crawler & workers

| Variable | Default | Notes |
|---|---|---|
| `CRAWLER_USER_AGENT_SUFFIX` | `DealerIntelResearch/0.1` | Appended to the browser user agent; the part before `/` is the robots.txt agent name. |
| `CRAWLER_PAGE_DELAY_MS` | `1500` | Minimum wait between pages on one site. |
| `CRAWLER_MAX_PAGES` | `10` | Page budget per scan (max 25). |
| `WORKER_CONCURRENCY` | `2` | Parallel browser jobs. |
| `ALLOW_LOCAL_TARGETS` | `false` | Development/test only: lets the crawler reach localhost fixtures. Ignored in production. |

## Interaction ceilings

These are hard limits. Admin settings can be stricter, never looser.

| Variable | Default | Allowed |
|---|---|---|
| `MAX_CHAT_MESSAGES` | `3` | 0–3 |
| `MAX_TESTS_PER_DEALERSHIP_PER_30_DAYS` | `1` | 0–1 (`0` disables all testing) |
| `MAX_HUMAN_REPLIES` | `1` | 0–1 (the system never replies in this version) |
| `ALLOW_APPOINTMENT_BOOKING` | `false` | must be `false` |
| `ALLOW_FINANCE_APPLICATIONS` | `false` | must be `false` |
| `ALLOW_TRADE_IN` | `false` | must be `false` |
| `ALLOW_TEST_DRIVE` | `false` | must be `false` |

Setting any `ALLOW_*` to `true` stops the app from starting: this version has no code that performs those actions.

## Admin settings (stored in the database, edited in Settings)

`testingEnabled`, `interactionCooldownDays`, `maxChatMessages`, `maxHumanReplies`, `responseMonitorHours`, `websiteScanIntervalDays`, `inventoryScanIntervalDays`, `socialScanIntervalDays`, `signalScanIntervalDays`, `aiProvider`, `aiModel`, `maxAIRequestsPerJob`, `maxAITokensPerJob`, `screenshotRetentionDays`, `evidenceRetentionDays`, `scoringWeights`, `scoringThresholds`.

## Local development ports

| Port | What |
|---|---|
| 5310 | Web app |
| 5311 | Fixture test site |
| 54330 | Embedded PostgreSQL (`DEV_PG_PORT`) |
| 63790 | Local Redis (`DEV_REDIS_PORT`) |
