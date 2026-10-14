# SarvX AI Intelligence Command Center (Dealer Intel)

A dealership research and sales-intelligence platform run by nine named agents. It researches automotive dealerships and groups, finds evidence of gaps in lead follow-up, inventory outreach, service scheduling and social response, scores each account with explainable rules, and hands sales a prioritised list with the evidence attached.

```
DISCOVER → SCAN WEBSITE → IDENTIFY TECHNOLOGY → TEST ALLOWED LEAD FLOWS → MEASURE RESPONSE
        → COLLECT SIGNALS → SCORE → SALES BRIEF → SALES QUEUE
```

**Principle:** normal software collects evidence, AI only interprets it. Scores are deterministic and never come from an LLM.

## What works today

| Area | Status |
|---|---|
| Dealership + group CRUD, CSV import, duplicate prevention | Working |
| Suppression at dealership / group / domain / phone level | Working |
| Playwright website scan: chat, forms, inventory, service, social links, careers, technology, screenshots | Working |
| Deterministic scoring for 4 products + overall priority, with reasons | Working |
| Controlled form test: request → approve → submit → response timer | Working (off by default) |
| Response intake: SMS / email / phone webhooks + manual entry, milestones, rule classification | Working |
| Sales brief with evidence-linked claims, roles, next action | Working (template angle without AI; AI angle when a key is set) |
| Hiring signals from the dealership's own careers page; manual signals with source | Working |
| Group roll-up: shared technology, systemic problems, group score | Working |
| Automated chat test: opens the widget, passes a contact gate and department menu, asks an approved question and keeps a short conversation going from an approved follow-up list (max 3 messages, stops when a person joins) | Working (best-effort; manual log for widgets it cannot drive) |
| Phone check: Charlie calls the number, records what answers and classifies it (person / AI receptionist / menu / voicemail) | Working when Twilio is configured; labelled otherwise |
| Talk to an agent: ask by text or voice, it answers from its own recorded work and speaks (browser speech; AI wording when a provider is configured, rule-based otherwise) | Working |
| Research window 07:00–21:00 America/Chicago (DST-safe); reply monitoring 24/7 | Working |
| Command Center: live metrics, the workforce network (ambient signal motion plus labelled real hand-offs), live activity | Working |
| Agent workspaces (`/agents/<key>`): Overview, Live activity (per-step events with timestamps and evidence links), Findings, Evidence, History, Configuration; pause/resume | Working |
| Active Research, Activity History (every agent step), Sales Intelligence (briefs with copy buttons) | Working |
| Live agent animations (Motion): nine scenes driven only by stored events and records; Orion hub with dispatch pulses; replay of any finished task at recorded timings; labelled demo mode | Working |
| Live updates over an authenticated Server-Sent Events stream (`/api/events/stream`), polling fallback | Working (Supabase Realtime is not used in this deployment) |
| Daily lead list CSV export | Working |
| Public social connector (follower/post counts a profile page shows without signing in) | Working, limited: most platforms show little or nothing to a visitor who is not signed in |
| Job queue, scheduler, job log, audit log, retention sweep | Working |

## Prospecting (finding dealerships on its own)

Nova finds **independent** car dealers from OpenStreetMap (public map data, `shop=car` with a website), rotating through about 170 metro areas across the United States, big cities and mid-size ones (or around one centre point when nationwide is off), and screens one candidate every interval (default 30 s). Manufacturer franchise stores, national chains and non-US entries are never candidates. Passive research presents as a normal Chrome with the research tag kept in the user agent (a setting; the headless presentation is refused outright by many sites). CAPTCHAs and bot challenges are never bypassed. A candidate is admitted only when its site can be researched end to end: the homepage reads cleanly (no block, no robots refusal, no CAPTCHA), it has an inventory section and a way to make contact, the inventory page and the service page (if linked) read cleanly, and if a chat widget is installed its launcher actually appears when the page is opened as a visitor. Admitted candidates become dealerships and enter **the relay**; everything else is listed under **Prospecting** with the reason and never becomes a dealership. Prospecting is on by default and runs around the clock; both are settings.

**The relay (one dealership at a time).** An admitted dealership is passed from agent to agent, and Nova does not screen the next candidate until the baton comes back: Nova reads the website (discovery, full scan) → Sentinel estimates monthly sales from the lot → Charlie calls the dealership (if Twilio is set up and *phone check mode* is auto) and then tests the chatbot (if there is one and *chat test mode* is auto) → Sage reads the social presence → Hunter checks hiring and growth → Atlas scores it → Blaze writes the call brief, and the relay is over. Each hand-off is a real event ("Hand-off to Charlie — website read; call the dealership"), which is what the workforce stage animates and what the Command Center's *Relay* figure and the Prospecting page report. A stage that fails for good, gets parked for research hours, or sits for 30 minutes releases the baton so one stuck job never stops prospecting. Rescans the scheduler queues for dealerships already on file run alongside and are not part of the relay. Implementation: `src/workers/relay.ts`.

## Size of operation (estimated)

Every dealership page carries a **Size of operation** card: vehicles on the lot, an estimated number of vehicles sold a month, estimated gross vehicle sales a month, and the typical asking price. These are inferences from the website, never reported figures, and the card says which method produced them. Stock is segmented by median asking price (budget, mainstream, premium, luxury, exotic), each with the turn rate and front-end gross per vehicle that segment does in the trade: a mainstream used lot turns every 55–75 days and makes about $1,900–$2,600 on a car; an exotic lot turns every 150–240 days and makes $8,000–$15,000. Until inventory reads at least five days apart exist, the estimate is lot ÷ days-to-turn × 30 (low confidence). Stated lots above 300 are treated as group or feed inventory and estimated as 300; no rooftop is credited with more than 150 sales a month. After that it is measured: listings that disappeared between snapshots are counted as sold, scaled to the lot and to 30 days, with confidence rising as the observed window passes two and then four weeks. Gross profit a month is units × the segment's front-end gross per vehicle (the dealer's commission on each sale); a salesperson's typical cut is about a quarter of that. Sales volume (units × median asking price) is shown too, but profit leads. Sentinel writes the estimate on the dealership after every website scan and inventory read, so the Snapshot strip, the Opportunities list and the Sales Intelligence briefs all show it; `npm run estimate-admin -- backfill` estimates every dealership on file at once. Implementation: `src/domain/volume.ts`; prices are read by `extractPrices` in `src/workers/website/detect.ts` and stored on each inventory snapshot.

## Buying intent, call queue and results

Every dealership carries an explainable **buying-intent score** (0-100) from a fixed rubric: a privately owned group of 2-5 rooftops (20), currently advertising vehicles (15), hiring BDC or internet-sales staff (15), verified slow or missed lead follow-up from a controlled test (20), no clear after-hours response process (10), an owner or GM on file with a source (10), confirmed interest logged by the sales team (10). Each signal shows points, status (observed / inferred / unknown), confidence, the agent responsible and its evidence; unknowns score nothing. Bands: 75+ high, 45-74 medium, under 45 low. **Buyer readiness** (confirmed interest, possible opportunity, no demonstrated interest, not interested) comes only from logged sales outcomes and is kept apart from the score. Atlas recomputes after every scoring run and every logged outcome (`src/domain/intent.ts`, `intent-run.ts`; `npm run intent-admin -- backfill|status`).

**Call Queue** ranks who to call today (follow-ups due, confirmed interest, score, rooftops, recency), excludes suppressed, not-interested, won and lost dealerships and anyone touched in the last two days, and shows the brief with a tap-to-call number. **Results by Band** counts logged outcomes per band so you can see whether the score predicts sales; rates appear once a band has ten or more dealerships worked. The Command Center shows the bands, confirmed interest, meetings booked, customers closed and a projected MRR (high-priority count × the price per location in Settings), labelled projected.

## The nine agents

Each agent is a name over existing queues and rules (`src/domain/agents.ts`); nothing about an agent's status is simulated. A card shows **Working** only while a `job_runs` row on its queues is RUNNING, **Waiting** only while a live test is MONITORING (Echo) or waiting for approval (reported by Orion), **Scheduled** only while its queues hold queued or parked jobs, **Error** after a failed run, **Completed** for ten minutes after a successful one, and **Paused** when its queue is paused.

| # | Agent | Role | Queues / rules |
|---|---|---|---|
| 01 | Nova | Website intelligence | discovery, website-scan, inventory |
| 02 | Charlie | Chat & form testing | interaction (form submit, chat probe) |
| 03 | Sage | Social media intelligence | social |
| 04 | Hunter | Hiring & business signals | signals |
| 05 | Atlas | Opportunity scoring | scoring |
| 06 | Blaze | Sales intelligence | sales-intel |
| 07 | Orion | Orchestration | scheduler + research window |
| 08 | Echo | Response monitoring | response-check + inbound webhooks |
| 09 | Sentinel | Revenue & volume estimates | inventory reads, asking prices, monthly units and gross-sales estimates (policy checks are enforced in code and reported by Orion) |

Every step an agent takes is written to `agent_events` by `src/lib/agent-events.ts` with a typed `kind` (`task.created`, `task.started`, `task.step.completed`, `finding.created`, `evidence.saved`, `response.received`, `task.failed`, `task.completed`, `task.blocked`, `task.scheduled`) and shown in the agent's Live activity tab and in Activity History.

**Animations are driven by those events, never by timers of their own.** `src/components/agents/` holds the stream provider (SSE with polling fallback), the nine scenes (`scenes/`), the Orion command stage, the replay player and demo mode. A scene receives the agent's live status, its current task, its recent events and the latest stored records for its work; idle agents show a slow ambient glow, working agents show the real steps as they arrive, waiting agents show the open item they wait on. All motion is disabled under `prefers-reduced-motion`.

**Replay** (History tab → Replay) plays a finished task back from its stored events at their recorded offsets, at 1×, 4× or 12×, with a scrubber. **Demo mode** (`?demo=1` on the Command Center, AI Agents or any workspace) runs a scripted, clearly labelled sequence against a fictional "[Demo] Example Motors"; every demo event is flagged and nothing is written to the system. Agents are shown as letter marks in their own colour (no artwork); the ring on a mark turns only while that agent is working.

## Checking the agents one at a time

With the dev stack running, `npm run agent-check` drives a single agent against a single dealership and prints every step as it is recorded (the same lines the agent's Live activity tab shows):

```
npm run agent-check -- status                      # every agent's live status
npm run agent-check -- discovery <domain>          # Nova reads name / phone / address / brands
npm run agent-check -- website-scan <domain>       # Nova full scan (chains to Atlas and Blaze)
npm run agent-check -- inventory <domain>          # Nova inventory count
npm run agent-check -- signals <domain>            # Hunter careers page
npm run agent-check -- social <domain>             # Sage public profiles
npm run agent-check -- scoring <domain>            # Atlas
npm run agent-check -- sales-intel <domain>        # Blaze
npm run agent-check -- scheduler                   # Orion: one scheduler tick
npm run agent-check -- park inventory <domain>     # Orion: a scheduled job parked until research hours
npm run agent-check -- unpark                      # remove parked jobs
npm run agent-check -- events <agent> [n]          # last n events for an agent
```

Charlie, Echo and Sentinel are checked through the app against the local fixture site (`npm run fixture-site`, then add `http://127.0.0.1:5311` as a dealership named so it is obviously a test, approve testing, request and approve a form or chat test, log a reply, request a second test to see the cooldown refusal). Delete the fixture dealership afterwards.

## Not built yet (clearly labelled in the UI too)

- **Social activity beyond public counts.** Posting frequency and unanswered questions still need an operator or an authorised platform API; the public connector only reads what a page shows without signing in.
- **External signal connectors** (job boards, news, ad libraries). Interface is the same Signal table; only the careers-page source and manual entry exist.
- **Docker images** are written but were not built on the development machine (no Docker there). Local development uses `npm run dev`, which needs no Docker.
- **AI features** are implemented but were not exercised against the live API during the build (no key was configured). Everything runs without AI.

## Quick start (no Docker)

Requirements: Node 22+.

```bash
npm install
npm run playwright:install
npm run dev
```

`npm run dev` starts a real PostgreSQL and Redis locally, applies migrations, creates the first admin, and runs the web app (http://localhost:5310) and the workers.

**For day-to-day use, run `npm run fast` instead.** It builds the app once (about 20 seconds) and serves the optimised version; pages then render in tens of milliseconds. `npm run dev` recompiles each page on first visit and is 10–40× slower per page; it is only worth it while editing code.

- The generated admin login is written to `.data/dev-credentials.txt`.
- The automated tests use a local fixture "dealership"; it is not started with the app. Run `FIXTURE_SITE=1 npm run dev` only if you want it for development.

## Quick start (Docker)

```bash
cp .env.example .env    # fill in the blanks; see ENVIRONMENT.md
docker compose up --build
```

## Hosted viewer on Vercel

The agents need a long-lived machine; the dashboard does not. With `REDIS_URL` empty the app runs as a **hosted viewer** of the research data (Vercel + Neon Postgres, both free): every dealership, phone number, verdict, estimate and brief, synced up from the research machine with `npm run sync-to-hosted`. See DEPLOYMENT.md → Vercel.

## Keeping it running (always on)

The dev preview only lives while a Claude session holds it. To keep the app up on its own, run once from this folder:

    scriptsservice.cmd install

That puts a small launcher in your Windows Startup folder (no admin rights) and starts the server now; `scriptsun-forever.cmd` builds, serves on port 5310 and restarts itself if it stops, logging to `.dataserver.log`. Other commands: `service.cmd start | stop | status | remove`. Stop it before a rebuild from a session, since two copies cannot share the port or the embedded database.

## Everyday commands

```bash
npm run typecheck
npm run lint
npm test                # unit + end-to-end against the local fixture site only
npm run db:generate     # after editing src/db/schema.ts
npm run db:migrate
```

## Before testing real dealerships

Controlled testing is **off** until an admin does all of this:

1. Settings → add a company-owned test identity (an inbox and phone number you control).
2. Point your SMS/email provider's inbound webhooks at `/api/webhooks/sms` and `/api/webhooks/email` (see SECURITY.md).
3. Settings → "Allow controlled tests".
4. Approve each dealership for testing, then request and approve each individual test.

Read `SECURITY.md` and `WORKERS.md` first. Get your own legal sign-off on test inquiries before turning this on.

## Documentation

`ARCHITECTURE.md` · `DATABASE.md` · `WORKERS.md` · `SCORING.md` · `SECURITY.md` · `DEPLOYMENT.md` · `TESTING.md` · `ENVIRONMENT.md`
