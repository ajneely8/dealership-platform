# Architecture

## Shape

Two processes share one PostgreSQL database, one Redis, and one object store:

```
            ┌────────────────────────┐        ┌─────────────────────────────┐
 Browser ──▶│ web  (Next.js)         │        │ worker (Node + Playwright)  │
 Webhooks ─▶│ pages, server actions, │        │ 9 BullMQ workers + scheduler│
            │ /api/webhooks, /api/…  │        └──────────────┬──────────────┘
            └───────────┬────────────┘                       │
                        │  enqueue                 consume   │
                        ▼                                    ▼
                    ┌────────┐   ┌──────────────┐   ┌──────────────────┐
                    │ Redis  │   │ PostgreSQL   │   │ S3-compatible    │
                    │ BullMQ │   │ all records  │   │ screenshots only │
                    └────────┘   └──────────────┘   └──────────────────┘
```

There is no single "agent". Each worker does one job, writes structured rows, and enqueues the next stage. Workers never call each other.

## Pipeline

```
add/import ─▶ discovery ─▶ website-scan ─▶ scoring ─▶ sales-intel ─▶ dashboard
                               ▲              ▲
   scheduler: inventory ───────┤              │
   scheduler: signals ─────────┤              │
   scheduler: social ──────────┘              │
   approve test ─▶ interaction ─▶ response-check (5m,15m,1h,4h,24h,72h) ─┘
   webhook / manual response ─────────────────────────────────────────────┘
```

## Where things live

```
src/
  env.ts                 validated environment (zod); hard safety ceilings
  db/                    Drizzle schema, migrations runner, admin seed
  domain/                business rules — pure functions first, DB wrappers second
    constants.ts         enums: products, stages, signal types, milestones, roles
    dedupe.ts            duplicate detection
    suppression.ts       suppression evaluation + rule management
    eligibility.ts       THE gate every controlled test passes through
    response-timing.ts   response seconds, milestones, rule-based classification
    responses.ts         recording responses, matching inbound webhooks
    scoring/             config (rules+weights), engine (pure), run (persist)
    brief.ts             evidence-linked sales brief builder (pure)
    agents.ts            the nine-agent registry + status derivation (pure)
    research-window.ts   research hours in the configured time zone (pure)
    checks.ts            the three questions + fit verdict (pure)
    group-intel.ts       group roll-up
  workers/
    runner.ts            queue → handler map, job_runs logging, timeouts
    scheduler.ts         recurring cadences + retention sweep
    website/             crawler, in-page snapshot, pure detectors, robots, vendors
    interaction/         form submission
    response-check.ts, sales-intel.ts, social.ts
  ai/                    provider interface, Anthropic provider, cache, budget, tasks
  queue/                 BullMQ queues, policies, idempotent enqueue
  lib/                   auth, audit, settings, storage, evidence, normalisation, webhooks
    job-context.ts       AsyncLocalStorage: agent, job run, dealership, AI usage for the running job
    agent-events.ts      emit() — one row per agent step
    agent-state.ts       live agent status, metrics, event and history queries for the UI
  app/                   Next.js UI, server actions, API routes
tests/                   unit tests + fixture site + end-to-end test
```

## Design rules

1. **Evidence first.** Playwright extracts a small structured `PageSnapshot` in the page (links, forms, script/iframe URLs, short texts, JSON-LD). Detectors are pure functions over snapshots. Raw HTML is never stored and never sent to a model.
2. **Deterministic scores.** `scoreProducts(facts, config)` is a pure function. The same facts always give the same score, and every point has a reason with evidence refs.
3. **Observed vs inferred.** Every score reason, finding, signal and brief claim carries `kind` (OBSERVED | INFERENCE) and `confidence` (HIGH | MEDIUM | LOW).
4. **Fail closed on contact.** Any doubt about a controlled test (suppression, cooldown, identity, domain, form type, CAPTCHA, unknown required field) means it is skipped and the reason is logged.
5. **AI is optional and boxed in.** It classifies response text and rewrites the sales angle. It cannot change scores, cannot add claims, and its angle is discarded if it cites an unknown claim or contains a number that is not in the cited claims.
6. **Idempotent jobs.** Deterministic job ids prevent duplicates; scoring and brief generation write nothing when nothing changed; form submission claims its row atomically and has no automatic retry.

## Extending

| To add | Do this |
|---|---|
| Another AI vendor | Implement `AIProvider` in `src/ai/`, return it from `resolveProvider()` |
| A social platform | Implement `SocialConnector`, add it to `SOCIAL_CONNECTORS` |
| An external signal source | New worker/connector that inserts `signals` rows with `sourceUrl` + `dedupeKey` |
| A scoring rule | Add to `RULES` in `scoring/config.ts` and `RULE_LOGIC` in `scoring/engine.ts`; add a test |
| A vendor signature | Add to `src/workers/website/vendors.ts` |
| CRM / Slack / email reports | Consume `sales_briefs` + `dealerships` (or add a queue after `sales-intel`) |
