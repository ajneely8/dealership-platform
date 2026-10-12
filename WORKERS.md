# Workers

Run with `npm run workers` (or the `worker` Docker service). One process runs every queue's worker plus the scheduler. Entry point: `src/workers/index.ts`; handlers: `src/workers/runner.ts`.

## Queues

| Queue | Worker role | What it does | Then enqueues | Attempts | Timeout |
|---|---|---|---|---|---|
| `discovery` | Discovery | Confirms the site loads; fills blank phone/address/coordinates/brands/parent group from the site's own schema.org data. Never overwrites operator-entered values. | `website-scan` | 3 | 90s |
| `website-scan` | Website | Full passive scan (below). | `scoring` | 3 | 6m |
| `inventory` | Website (light) | Homepage + listing pages → inventory snapshot. | `scoring` | 3 | 4m |
| `signals` | Signal | Careers page → hiring signals. | `scoring` | 3 | 3m |
| `social` | Social | Runs configured social connectors. **None ship in V1**, so this records a skip. | `scoring` | 2 | 2m |
| `scoring` | Scoring | Deterministic scores, findings, priority, group roll-up. | `sales-intel` | 3 | 30s |
| `sales-intel` | Sales Intelligence | Optional AI response classification, then the brief. | — | 3 | 90s |
| `interaction` | Interaction | Submits one approved form test. | `response-check` | **1** | 3m |
| `response-check` | Interaction | Evaluates response milestones; closes the window. | `scoring` | 5 | 30s |

Retries use exponential backoff. Failed jobs are kept and can be retried from **Jobs** (interactions cannot be retried — request a new test). Every run is recorded in `job_runs`.

Job ids are deterministic (`<queue>_<dealershipId>`), so the same work is never queued twice.

## Agents and events

Queues map to the nine agents in `src/domain/agents.ts` (`agentForQueue`). `executeJob` runs every handler inside a job context (`src/lib/job-context.ts`) that carries the agent key, job run id and dealership id, so any code can call `emit(step, { detail, status, evidenceId })` from `src/lib/agent-events.ts` without plumbing. The runner itself emits start/finish/fail/parked events; handlers emit their own steps (page opened, screenshot saved, chat detected, forms found, signals saved, scored, brief built, test submitted, reply recorded, policy decision). Events are rows in `agent_events`; a failed insert is logged and never fails the job. `src/lib/agent-state.ts` derives each agent's live status from queue counts, RUNNING job runs, open tests and the last outcome — the UI never invents a status. Each event also carries a `kind` from the fixed vocabulary in `agent-events.ts`; the runner sets `task.started`/`task.completed`/`task.failed`/`task.blocked`/`task.scheduled`, the scheduler and operator actions set `task.created`, handlers set `finding.created` for stored findings and `evidence.saved` (automatic when an `evidenceId` is attached), and Echo sets `response.received`. The browser receives events over `/api/events/stream` (SSE, tailing the table every 1.5 s, agent state every 4 s).

## Website scan

1. Read `robots.txt`; disallowed paths are skipped and recorded.
2. Visit the homepage. If it is an access-control or challenge page, record `BLOCKED` and stop. **No CAPTCHA solving, no evasion.**
3. From homepage links, visit up to `CRAWLER_MAX_PAGES`: new/used inventory, one vehicle page, contact, service, scheduler, careers, about. Waits `CRAWLER_PAGE_DELAY_MS` (or the site's crawl-delay) between pages.
4. On each page, extract a structured snapshot in the browser. Detectors (pure functions) turn snapshots into: chat presence/vendor/type, classified forms, inventory counts, service scheduler mode and friction, social links, technology, hiring signals.
5. Store the observation, inventory snapshot, signals, social profiles, and screenshots (HOMEPAGE, INVENTORY, FORM, SERVICE).

The crawler identifies itself (`CRAWLER_USER_AGENT_SUFFIX`), never fills in or submits anything, and refuses private/local addresses unless `ALLOW_LOCAL_TARGETS=true` (development only).

### Honest limits
- Inventory count is read from a stated total on the page (medium confidence) or, failing that, the number of listing links on the first page (low confidence, a minimum).
- Chat *type* comes from the vendor signature; whether chat *works* is unknown until a test is logged.
- "No inventory alerts" only means none were found on the pages scanned.
- Sites that render everything behind heavy client-side frameworks or block automated browsers will produce thin or `BLOCKED` observations.

## Controlled interaction (form test)

```
operator requests ─▶ eligibility check ─▶ PENDING_APPROVAL
operator approves ─▶ eligibility check ─▶ APPROVED ─▶ queue
worker claims (atomic) ─▶ eligibility check ─▶ open page ─▶ find form ─▶ eligibility check on the real form
   ─▶ fill ─▶ form validity check ─▶ screenshot ─▶ click submit (timer starts) ─▶ screenshot ─▶ MONITORING
```

It stops **without submitting** when: testing is off, the dealership is not approved, paused or suppressed, a test is already active, the cooldown has not passed, the identity is missing/inactive, the URL is off the dealership's domain, the form is not an inquiry form, the form has finance/trade-in/appointment/test-drive fields, a CAPTCHA is present, a required field is not understood, or the form's own validation fails.

Only these messages can be sent (`APPROVED_MESSAGES`):
- "Is this vehicle still available?"
- "Do you have any similar models available?"
- "Can someone send me more information about this vehicle?"
- "Can someone send me more information about your current inventory?"

The system **never replies** to a dealership. After submission it only observes.

## Research window

Research queues (`discovery`, `website-scan`, `inventory`, `signals`, `social`, `interaction`) run only inside the window set in Settings (default 07:00–21:00 America/Chicago, DST handled by the platform's IANA zone data). A job that arrives outside the window is parked until it opens. Work an operator starts by hand carries `manual: true` and runs immediately. `response-check`, `scoring`, `sales-intel` and the inbound webhooks run around the clock, so a reply at 23:30 is recorded on time.

## Automated chat test

`src/workers/interaction/chat-probe.ts`. Same approval, suppression and identity gate as the form test, with its own 30-day cooldown. Opens the page, finds the launcher, fills a name/email/phone gate from the identity if the widget insists, sends ONE approved question, watches 90 s (plus a 20 s grace after the first reply), records each reply as a CHAT response, saves the transcript and two screenshots, and marks the chatbot working or not. It never sends a second message. Widgets it cannot drive end as FAILED with a reason; log those by hand.

## Scheduler

Every 5 minutes (`src/workers/scheduler.ts`), using intervals from Settings:

| Job | Default cadence |
|---|---|
| Website scan | 14 days |
| Inventory | 7 days |
| Signals (careers page) | 1 day |
| Social | 3 days |
| Response checks | at each milestone; a sweep re-creates any that were lost |
| Suppression expiry | each tick |
| Retention sweep | daily |

Controlled interactions are never scheduled. Each one needs a person.

### Browser identity

Passive research (Nova, Hunter, Sage) runs with the headless browser's own user agent plus the research suffix (`CRAWLER_USER_AGENT_SUFFIX`), so a site can tell a scan from a visitor. Approved controlled tests (Charlie's form and chat tests) open the page with `present: "visitor"`: the `HeadlessChrome` token becomes `Chrome` so chat vendors serve the same widget a customer gets (CarNow, for one, withholds its launcher from a headless browser entirely), and the research suffix stays on so the visit remains identifiable in the dealership's logs. Nothing else changes: robots rules, CAPTCHA stops, the one-question limit and the identity rules all still apply. `npm run chat-diagnose -- <url> [visitor]` shows what a launcher search sees under either presentation.

## Inventory prices and the size-of-operation estimate

`readInventory` now also reads asking prices (`extractPrices`: dollar amounts between $1,500 and $350,000 that are not monthly payments, capped at 300) and `persistInventory` stores them with their median on the snapshot. After storing, it emits the price count and median; Sentinel's `estimate` job (`src/workers/estimate.ts`) then runs `estimateVolume` (`src/domain/volume.ts`) over the last 12 snapshots, writes the result on the dealership (`est_*` columns, migration 0009) and emits "<name>: estimated about N–M vehicles a month …" as a finding. Turnover needs two snapshots ≥ 5 days apart with ≥ 8 sampled listing links each; otherwise the lot-size method is used and labelled as a first guess.

## The relay (new dealerships, one at a time)

`src/workers/relay.ts`. Prospecting admits a dealership and calls `relayStart`; the baton is one row in the `settings` table (key `relay`: dealership, stage, when the stage began, a note). `prospectTick` calls `relayHolding()` first and does nothing while a relay is live, so Nova screens nobody else. Stages and the handler that advances each one:

| Stage | Who | Advanced by |
|---|---|---|
| nova | discovery → website-scan | website-scan handler → `afterNova`: hands to Sentinel and queues `estimate` |
| sentinel | estimate (arithmetic over stored snapshots; the weekly `inventory` read is Sentinel's too) | estimate/inventory handlers → `afterSentinel`: approves testing and queues `phone-check` (Twilio + phone check mode auto), else goes straight to the chatbot |
| charlie | phone-check → interaction (CHAT) | phone-check handler → `afterPhoneCheck` → chat test via `requestChatTestFor` when the latest observation has a chat widget; interaction handler → `afterCharlie` queues `social` |
| sage | social | social handler → `afterSage` queues `signals` |
| hunter | signals | signals handler → `afterHunter` (scoring is already queued) |
| atlas | scoring | scoring handler → `afterAtlas` (sales-intel is already queued) |
| blaze | sales-intel | sales-intel handler → `afterBlaze` → `relayFinish` |

Every hand-off emits `Hand-off to <Agent> — <note>` (kind `task.created`) from the agent letting go, which the workforce stage draws as a message between the two. The baton is released early by `relayFinish` when the dealership is removed as unresearchable, when a stage's job fails on its last attempt, or when a stage is parked for the research window; `relayHolding` also releases a relay that has not moved in 30 minutes (Orion says so). Scheduler rescans for existing dealerships are not part of the relay and run beside it; an operator's manual scan still fans out to Hunter and Sage at once.

## Chat conversations and phone checks

**Conversation.** After the first approved question, Charlie listens for 90 s. For each reply it decides, with `pickFollowUp` in `src/domain/chat-followups.ts`, whether to wait (the widget is connecting a person, or asking for contact details — the contact gate answers that), send one approved follow-up (asked which vehicle → the inventory line; confirmed availability → "send me more information"; otherwise the generic inventory question), or stop. Limits: `maxChatMessages` messages from us in total (default 3, hard maximum 3) and no more messages once a person has joined (`maxHumanReplies`, default 1). Every line we say comes from `APPROVED_MESSAGES` or `APPROVED_FOLLOWUPS`; nothing is composed.

**Phone check (queue `phone-check`, Charlie).** With Twilio configured (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`), Charlie calls the dealership's number once with answering-machine detection on and polls the call every second. The time from ringing to answer is measured (about 6 s per ring in the US) and reported as a ring count. If a **person** answers and *hang up on human* is on (default), the call is ended at once and nothing is said to them; the verdict is "a person answered after N rings". Otherwise Charlie speaks the script from Settings, records up to 45 s of what answers, hangs up, and classifies the answer with `classifyPhoneAnswer` (`src/domain/phone-answer.ts`): an AI receptionist (it says so: "virtual assistant", "I'm an AI…"), a phone menu ("press one"), voicemail ("leave a message"), a person (greeting plus the line's own answering-machine detection), or no answer. The verdict, its reason and confidence land in the dealership's *AI receptionist* card; the recording is evidence of type CALL. One call per dealership per cooldown, only with testing approval, never without Twilio. The call, recording and transcription are polled through Twilio's REST API, so no public webhook URL is needed. Calls are recorded: the operator is responsible for call-recording consent rules in the state called.
