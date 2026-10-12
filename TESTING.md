# Testing

```bash
npm test          # everything (about a minute; the end-to-end file starts a browser)
npm run typecheck
npm run lint
```

## Rule: tests never touch a real dealership

- When `NODE_ENV=test`, the crawler throws on any non-local host (`assertAllowedTarget` in `src/workers/website/crawler.ts`).
- All browser tests run against **Fixture Motors**, a local test site in `tests/fixtures/site-server.ts`. It is labelled "LOCAL TEST SITE" on every page and is not a real business.

## What is covered

| File | Covers |
|---|---|
| `tests/domain.test.ts` | Normalisation; duplicate detection (domain, phone, address, name+location, name+group); suppression at every level incl. group suppression and expiry; interaction eligibility (disabled, unapproved, paused, suppressed, cooldown floor, active test, identity, domain, prohibited form types/fields, CAPTCHA); response timing and milestones; rule-based classification; brief evidence references; AI grounding check; group roll-up |
| `tests/scoring.test.ts` | Spec weights; every product's rules; "not yet knowable" cases; clamping at 100; weight 0 disables a rule; inventory movement; signal recency; priority components; determinism |
| `tests/detect.test.ts` | Block detection; chat/technology signatures; link discovery; form classification incl. never-submit types; form-fill planning; inventory reading; service detection; hiring extraction; schema.org parsing; robots.txt |
| `tests/pipeline.integration.test.ts` | Real PostgreSQL + Redis + headless browser against the fixture: scan → structured findings + screenshots → deterministic scores → brief → test skipped while disabled → approved test submits exactly once → second test refused (cooldown + active) → finance form never submitted → inbound email matched, timed, classified, idempotent → unmatched message parked → SummaryBot score rises to 55 → group suppression blocks testing → audit trail |

The end-to-end test boots its own throwaway PostgreSQL (`embedded-postgres`) and Redis (`redis-memory-server`) on ports 54377 / 63777. No Docker or external services needed.

## Not covered by automated tests

- UI pages and server actions (verified by hand in the browser during the build).
- The Anthropic provider against the live API (no key was available). `angleIsGrounded` and the template fallback are tested.
- S3 storage driver (the local driver is exercised; S3 uses the same interface).
- Webhook HTTP layer and Twilio signature check (the ingest logic behind it is tested).
- Docker images.

## Trying it by hand

`npm run dev`, sign in, add a dealership with website `http://127.0.0.1:5311`. Within about a minute it is discovered, scanned, scored and briefed. To try a controlled test against the fixture: add a test identity in Settings, enable testing, approve the dealership, request and approve a test, then record a response by hand on the dealership page. Submissions the fixture received are listed at `http://127.0.0.1:5311/__submissions`.
