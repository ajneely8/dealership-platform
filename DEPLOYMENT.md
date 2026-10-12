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
