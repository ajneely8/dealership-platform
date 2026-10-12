# Database

PostgreSQL, accessed through Drizzle ORM. Schema: `src/db/schema.ts`. Migrations: `drizzle/` (generated, committed).

```bash
npm run db:generate   # after changing schema.ts — creates a new SQL migration
npm run db:migrate    # applies pending migrations
npm run db:seed       # creates the first admin from ADMIN_EMAIL / ADMIN_PASSWORD if no users exist
```

The seed creates one admin and nothing else. There is no sample dealership data.

## Tables

### Accounts
| Table | Purpose |
|---|---|
| `dealer_groups` | A dealership group. `intel` (JSON) holds the latest roll-up; `priority_score` is the group score. |
| `dealerships` | One rooftop. Normalised name/domain/phone/address for dedupe. Pipeline stage, next action, priority (+ manual override), testing approval, paused, denormalised `suppressed` flag. |
| `contacts` | Named people. `source_url` is required. |
| `notes` | Operator notes. |

### Passive research
| Table | Purpose |
|---|---|
| `website_observations` | One row per scan: status, mobile, chat, forms (JSON), inventory, service details (JSON), social links, technology, careers URL, pages visited. |
| `inventory_snapshots` | Historical counts (total/new/used), how it was counted, confidence, listing URLs for churn, asking prices and their median (migration 0008) for the size-of-operation estimate. |
| `social_profiles` | Profile links found on the dealership's own site. |
| `social_observations` | Activity figures per platform. `source` is `MANUAL` or a connector name; `source_url` kept. |
| `signals` | Hiring/business signals. `source_url` required; `dedupe_key` prevents repeats; `kind` + `confidence`. |
| `evidence` | Screenshot metadata only (`storage_key`, `storage_url`, type, source URL). The image is in object storage. |

### Controlled interactions
| Table | Purpose |
|---|---|
| `test_identities` | Company-owned research identities. |
| `test_interactions` | One test: type, form, message, status, timestamps, `first_response_seconds`, `milestones`. |
| `responses` | Each reply: channel, `response_seconds`, classification, human/automation, quality fields, `classified_by`, `external_id` (idempotency). |
| `transcript_messages` | timestamp, speaker, channel, message. |
| `unmatched_inbound` | Inbound messages that could not be tied to exactly one open test. |

### Scoring and sales
| Table | Purpose |
|---|---|
| `scores` | Latest score per (dealership, product) with `reasons` JSON. |
| `score_history` | Appended only when a score changes. Feeds the timeline. |
| `findings` | Current findings, each OBSERVED or INFERENCE with confidence and evidence refs. |
| `sales_briefs` | Generated briefs: product, claims (with evidence refs), angle + its source (AI/TEMPLATE), roles, next action, `input_hash`. |

### Operations
| Table | Purpose |
|---|---|
| `suppressions` | Rules at DEALERSHIP / GROUP / DOMAIN / PHONE scope. Source of truth for suppression. |
| `job_runs` | Every job execution: worker, dealership, start/end, duration, status, error, retry count. |
| `audit_logs` | actor, action, entity, entityId, timestamp, metadata. |
| `settings` | Key/value admin settings, including scoring weights and thresholds. |
| `ai_cache` | AI results keyed by a hash of (task, model, input). |
| `users` | Dashboard users with role ADMIN / OPERATOR / VIEWER. |

## Conventions

- **Evidence refs.** Reasons, findings and brief claims point at supporting rows with `{ type, id }` where type is `observation | interaction | response | signal | inventory | social | evidence | transcript`.
- **Observed vs inference.** `kind` + `confidence` columns on `signals`, `findings`, and inside `scores.reasons` / `sales_briefs.claims`.
- **No binaries in Postgres.** Screenshots go to object storage; only keys and URLs are stored.
- **Cascade.** Deleting a dealership removes its research, tests, scores and evidence rows. Deleting a group un-groups its rooftops.
- **Retention.** The daily sweep deletes screenshots older than `screenshotRetentionDays` and research rows older than `evidenceRetentionDays` (Settings).

## agent_events

One row per step an agent takes (`src/lib/agent-events.ts`). Columns: `agent` (nova … sentinel), optional `job_run_id`, `dealership_id`, `interaction_id`, `evidence_id`, `at`, `step` (short sentence), `detail` (URL, counts, error text), `status` (INFO | DONE | BLOCKED | ERROR), `kind` (the event vocabulary, migration 0005). Indexed by agent+time, job run, and dealership+time. Dealership and interaction deletes cascade. Added in migration 0004.
