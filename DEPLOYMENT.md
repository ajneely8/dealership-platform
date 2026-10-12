# Deployment

> The Docker files in this repository were written but **not built or run** on the development machine (Docker was not installed there). Build and smoke-test them in your environment first. Everything else in this document describes the process that was verified locally with `npm run dev` and `npm run build`.

## Services

| Service | What | Notes |
|---|---|---|
| `web` | Next.js app (`next start`, port 5310) | Stateless. Can run more than one. |
| `worker` | `tsx src/workers/index.ts` | Needs Chromium (Playwright base image). Runs the scheduler: **run exactly one** unless you move the scheduler out. |
| PostgreSQL 15+ | All records | Back it up. |
| Redis 7 | BullMQ | Enable AOF persistence and `maxmemory-policy noeviction`, or delayed response checks can be lost (the scheduler sweep re-creates them, but late). |
| S3-compatible storage | Screenshots | MinIO, S3, R2. Turn on bucket encryption. |

## Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

`migrate` runs migrations and seeds the first admin, then `web` and `worker` start. Open http://localhost:5310.

## Railway (one container, recommended for a first hosted run)

`Dockerfile.railway` builds one image with the dashboard, the agents and Chromium; `scripts/start-all.mjs` applies migrations, seeds the first admin and runs both processes. `railway.json` points Railway at that Dockerfile and at `/api/health`.

1. New project → Deploy from GitHub → this repository. Then add **PostgreSQL** and **Redis** from the "+ New" menu.
2. On the app service, Settings → Volumes: mount a volume at `/data`. Settings → Networking: generate a public domain.
3. Variables on the app service (use Railway references for the two connection strings):

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` |
| `SESSION_SECRET` | 32+ random characters |
| `APP_URL` | the public domain, e.g. `https://<service>.up.railway.app` |
| `NODE_ENV` | `production` |
| `STORAGE_DRIVER` | `local` |
| `STORAGE_LOCAL_DIR` | `/data/evidence` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | first login (password 12+ characters); only used while the users table is empty |
| `AI_PROVIDER`, `AI_MODEL`, `ANTHROPIC_API_KEY` | `anthropic`, `claude-opus-5-5`, the key |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | phone checks |
| `WEBHOOK_SECRET` | random; the inbound webhook URL is `APP_URL/api/webhooks/<channel>` |
| `TTS_PROVIDER`, `OPENAI_API_KEY` | optional: agent voices and Whisper transcription (the Windows voice is not available in a container) |

4. Deploy. The health check passes once Postgres and Redis answer; the first build takes a few minutes (Chromium image plus `next build`).

Settings that live in the database (research hours, prospecting, phone and chat test modes) are set on the Settings page after the first login, not as variables.

## Without Docker

```bash
npm ci
npm run playwright:install
npm run build
npm run db:migrate
npm run db:seed
npm start          # web
npm run workers    # workers + scheduler (separate process)
```

## Production checklist

1. `SESSION_SECRET`: 32+ random characters. Changing it signs everyone out.
2. `APP_URL`: the public HTTPS URL (used for Twilio signature checks).
3. HTTPS at a reverse proxy; forward `X-Forwarded-For`.
4. `STORAGE_DRIVER=s3` with real credentials. `local` keeps evidence on one machine (fine for `npm run fast` on a workstation; it logs a warning in a production build).
5. `ALLOW_LOCAL_TARGETS` unset or `false`.
6. `ADMIN_EMAIL` / `ADMIN_PASSWORD` for the first sign-in, then create named users and remove the seed values.
7. Webhooks: set `WEBHOOK_SECRET` and/or `TWILIO_AUTH_TOKEN` before pointing providers at the app.
8. Leave "Allow controlled tests" off until identities, webhooks and your legal review are in place.
9. Give the worker container at least 1 GB of shared memory (`shm_size`) and 2 GB RAM per concurrent browser.

## Health

`GET /api/health` → `{ ok, database, redis }` (503 if either is down). Job failures: **Jobs** page and `job_runs`.

## Upgrades

1. Deploy the new image.
2. Run `npm run db:migrate` (the `migrate` service does this).
3. Restart `web` and `worker`. The worker finishes in-flight jobs on SIGTERM before exiting.

## Scaling notes

- Scan throughput is limited by `WORKER_CONCURRENCY` and the politeness delay per site, not by CPU. Add worker replicas for more parallel sites, but first move `startScheduler()` to a single dedicated process.
- The interaction queue always runs one job at a time.
