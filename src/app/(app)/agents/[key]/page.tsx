import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { setAgentPaused } from "@/app/actions";
import { Elapsed } from "@/components/agent-ui";
import { DemoBanner } from "@/components/agents/command";
import { AgentFeed, CurrentTaskBar } from "@/components/agents/feed";
import { ReplayPlayer } from "@/components/agents/replay";
import { AgentStreamProvider } from "@/components/agents/stream";
import { AgentVoice } from "@/components/agents/voice";
import { WorkspaceHeader, WorkspaceStage } from "@/components/agents/workspace";
import { sceneData } from "@/lib/scene-data";
import { A, Badge, Empty, ExternalLink, Flash, Panel, Provenance, fmtDate, label, timeAgo } from "@/components/ui";
import { db } from "@/db";
import { agentEvents, jobRuns } from "@/db/schema";
import { dealerships, evidence, findings, salesBriefs, scores, signals, socialObservations, testInteractions, transcriptMessages, websiteObservations } from "@/db/schema";
import { AGENTS, AGENT_KEYS, type AgentKey } from "@/domain/agents";
import { PRODUCT_LABEL, RECEPTIONIST_LABEL } from "@/domain/constants";
import { formatDuration } from "@/domain/response-timing";
import { fmtUsd } from "@/domain/volume";
import { hasRole, requireUser } from "@/lib/auth/session";
import { agentEventsFor, agentHistory, agentLive, jobRunById, toFeed, toSnapshot } from "@/lib/agent-state";
import { getSettings } from "@/lib/settings";

const TABS = ["overview", "activity", "dealerships", "findings", "evidence", "history", "configuration"] as const;
type Tab = (typeof TABS)[number];

export default async function AgentWorkspace({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<{ tab?: string; notice?: string; error?: string; demo?: string; replay?: string }> }) {
  const { key } = await params;
  if (!AGENT_KEYS.includes(key as AgentKey)) notFound();
  const agent = AGENTS[key as AgentKey];
  const { tab: rawTab, notice, error, demo: demoParam, replay } = await searchParams;
  const tab: Tab = TABS.includes(rawTab as Tab) ? (rawTab as Tab) : "overview";
  const demo = demoParam === "1";
  const user = await requireUser();
  const admin = hasRole(user, "ADMIN");
  const [live, events, history, settings, data] = await Promise.all([agentLive(agent.key), agentEventsFor({ agent: agent.key, limit: 80 }), agentHistory(agent.key, 40), getSettings(), sceneData(agent.key)]);
  const replayRun = replay && /^[0-9a-f-]{36}$/i.test(replay) ? await jobRunById(replay) : null;
  const replayEvents = replayRun ? await agentEventsFor({ jobRunId: replayRun.id, limit: 500 }) : [];
  const q = (t: Tab) => `/agents/${agent.key}?tab=${t}${demo ? "&demo=1" : ""}`;

  return (
    <AgentStreamProvider initialAgents={[toSnapshot(live)]} initialEvents={events.map(toFeed)} agentKey={agent.key} demo={demo}>
      <Flash notice={notice} error={error} />
      <DemoBanner exitHref={`/agents/${agent.key}?tab=${tab}`} />
      <WorkspaceHeader agentKey={agent.key}>
        <div className="flex flex-col items-end gap-1 text-[12px] text-muted">
          {live.nextScheduled ? <span>Next scheduled {fmtDate(live.nextScheduled, true)}</span> : live.lastAt ? <span>Last ran {timeAgo(live.lastAt)}</span> : null}
          <A href={demo ? `/agents/${agent.key}?tab=${tab}` : `/agents/${agent.key}?tab=${tab}&demo=1`}>{demo ? "Exit demo" : "Demo mode"}</A>
        </div>
        {admin && agent.queues.length ? (
          <form action={setAgentPaused} className="flex gap-2">
            <input type="hidden" name="back" value={`/agents/${agent.key}`} />
            {agent.queues.map((q, i) => (i === 0 ? <input key={q} type="hidden" name="queue" value={q} /> : null))}
            <input type="hidden" name="paused" value={String(!live.paused)} />
            <button className="btn" type="submit">
              {live.paused ? "Resume agent" : "Pause agent"}
            </button>
          </form>
        ) : null}
      </WorkspaceHeader>

      <div className="mb-4">
        <AgentVoice agentKey={agent.key} />
      </div>

      <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-line" aria-label="Workspace tabs">
        {TABS.map((t) => (
          <Link key={t} href={q(t)} className={`-mb-px border-b-2 px-3 py-2 text-[13px] ${tab === t ? "border-[color:var(--agent)] font-medium text-text" : "border-transparent text-muted hover:text-text"}`} style={{ "--agent": agent.color } as React.CSSProperties}>
            {t === "activity" ? "Live activity" : label(t)}
          </Link>
        ))}
      </nav>

      {replayRun ? (
        <div className="mb-5">
          <ReplayPlayer agentKey={agent.key} run={{ ...replayRun, startedAt: replayRun.startedAt.toISOString(), completedAt: replayRun.completedAt?.toISOString() ?? null }} events={replayEvents.map(toFeed)} data={data} />
        </div>
      ) : null}
      {tab === "overview" ? (
        <>
          <div className="mb-4">
            <WorkspaceStage agentKey={agent.key} data={data} />
          </div>
          <Overview agent={agent} live={live} />
        </>
      ) : null}
      {tab === "activity" ? (
        <>
          <div className="mb-4">
            <WorkspaceStage agentKey={agent.key} data={data} />
          </div>
          <Panel title="Live activity">
            <CurrentTaskBar agentKey={agent.key} />
            <AgentFeed agentKey={agent.key} limit={80} />
          </Panel>
        </>
      ) : null}
      {tab === "dealerships" ? <DealershipHistory agent={agent} /> : null}
      {tab === "findings" ? <Findings agent={agent} /> : null}
      {tab === "evidence" ? <EvidenceTab agent={agent} /> : null}
      {tab === "history" ? <History agent={agent} history={history} /> : null}
      {tab === "configuration" ? <Configuration agent={agent} settings={settings} admin={admin} /> : null}
    </AgentStreamProvider>
  );
}

function Overview({ agent, live }: { agent: (typeof AGENTS)[AgentKey]; live: Awaited<ReturnType<typeof agentLive>> }) {
  const s = live.stats7d;
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        <Panel title="Capabilities">
          <ul className="grid gap-x-6 gap-y-1.5 px-4 py-3 text-[13px] md:grid-cols-2">
            {agent.capabilities.map((c) => (
              <li key={c} className="flex gap-2">
                <span className="mt-[7px] inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: agent.color }} />
                {c}
              </li>
            ))}
          </ul>
        </Panel>
        {agent.key === "sentinel" ? <SentinelOverview /> : null}
      </div>
      <div className="space-y-4">
        <Panel title="Last 7 days">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3 text-[13px]">
            <Stat k="Tasks completed" v={s.completed} />
            <Stat k="Skipped by policy" v={s.skipped} />
            <Stat k="Failed" v={s.failed} bad={s.failed > 0} />
            <Stat k="Average time" v={s.avgMs ? `${(s.avgMs / 1000).toFixed(1)}s` : "—"} />
            <Stat k="AI requests" v={s.aiRequests} />
            <Stat k="AI cost (est.)" v={s.aiCostUsd ? `$${s.aiCostUsd.toFixed(3)}` : "$0.00"} />
            <Stat k="Queued" v={live.queued} />
            <Stat k="Parked for hours" v={live.parked} />
          </dl>
        </Panel>
        <Panel title="Runs on">
          <div className="px-4 py-3 text-[13px]">
            {agent.queues.length ? (
              <ul className="num space-y-1 text-[12px] text-muted">
                {agent.queues.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            ) : agent.key === "orion" ? (
              <p className="text-muted">The scheduler and every queue. Runs every 5 minutes inside the research window.</p>
            ) : (
              <p className="text-muted">Rules that run before every test and every submission: eligibility, suppression, cooldowns, prohibited forms, CAPTCHA stops, and the audit log.</p>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Stat({ k, v, bad }: { k: string; v: React.ReactNode; bad?: boolean }) {
  return (
    <div>
      <dt className="eyebrow">{k}</dt>
      <dd className={`num mt-0.5 text-[18px] font-medium ${bad ? "text-bad" : ""}`}>{v}</dd>
    </div>
  );
}

async function SentinelOverview() {
  const [rows, [total], [done], [turnover]] = await Promise.all([
    db()
      .select({ id: dealerships.id, name: dealerships.name, city: dealerships.city, state: dealerships.state, unitsLow: dealerships.estUnitsLow, unitsHigh: dealerships.estUnitsHigh, grossLow: dealerships.estProfitLow, grossHigh: dealerships.estProfitHigh, perUnit: dealerships.estProfitPerUnit, segment: dealerships.estSegment, confidence: dealerships.estConfidence, method: dealerships.estMethod, onHand: dealerships.inventoryCount })
      .from(dealerships)
      .where(and(eq(dealerships.suppressed, false), isNotNull(dealerships.estProfitHigh)))
      .orderBy(desc(dealerships.estProfitHigh))
      .limit(10),
    db().select({ n: dealerships.id }).from(dealerships).where(eq(dealerships.suppressed, false)).then((r) => [r.length] as const),
    db().select({ n: dealerships.id }).from(dealerships).where(and(eq(dealerships.suppressed, false), isNotNull(dealerships.estUnitsLow))).then((r) => [r.length] as const),
    db().select({ n: dealerships.id }).from(dealerships).where(and(eq(dealerships.suppressed, false), eq(dealerships.estMethod, "TURNOVER"))).then((r) => [r.length] as const),
  ]);
  return (
    <Panel title="Estimates right now">
      <div className="grid gap-px bg-line-soft md:grid-cols-3">
        <div className="bg-surface px-4 py-3 text-[13px]">
          <div className="eyebrow">Dealerships estimated</div>
          <div className="num mt-1 text-[22px] font-medium">
            {done} <span className="text-[13px] text-muted">of {total}</span>
          </div>
          <div className="text-[12px] text-muted">The rest get one on their next inventory read.</div>
        </div>
        <div className="bg-surface px-4 py-3 text-[13px]">
          <div className="eyebrow">Measured from turnover</div>
          <div className="num mt-1 text-[22px] font-medium">{turnover}</div>
          <div className="text-[12px] text-muted">Needs two inventory reads at least five days apart; the others are first guesses from lot size.</div>
        </div>
        <div className="bg-surface px-4 py-3 text-[13px]">
          <div className="eyebrow">How it is done</div>
          <div className="mt-1 text-[12.5px] text-muted">Stock is segmented by asking price (budget to exotic), each with the turn rate and front-end gross per vehicle that segment does in the trade. Listings that leave the lot between weekly reads count as sold. Lots above 300 are treated as group inventory, above 1,500 as marketing copy.</div>
        </div>
      </div>
      {rows.length ? (
        <table className="tbl">
          <thead>
            <tr>
              <th>Largest by estimated gross profit</th>
              <th className="text-right">On the lot</th>
              <th className="text-right">Sold a month</th>
              <th className="text-right">Gross profit a month</th>
              <th className="text-right">Per vehicle</th>
              <th>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <A href={`/dealerships/${r.id}`}>{r.name}</A>
                  <span className="ml-2 text-[12px] text-muted">{[r.city, r.state].filter(Boolean).join(", ")}</span>
                </td>
                <td className="num text-right">{r.onHand ?? "—"}</td>
                <td className="num text-right">{r.unitsLow}–{r.unitsHigh}</td>
                <td className="num text-right">{fmtUsd(r.grossLow!)} – {fmtUsd(r.grossHigh!)}</td>
                <td className="num text-right">{r.perUnit !== null ? fmtUsd(r.perUnit) : "—"}</td>
                <td>{label(r.confidence ?? "LOW")} · {r.method === "TURNOVER" ? "turnover" : "lot size"}{r.segment ? ` · ${r.segment.toLowerCase()}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Panel>
  );
}

async function Findings({ agent }: { agent: (typeof AGENTS)[AgentKey] }) {
  if (agent.key === "nova") {
    const rows = await db().select({ o: websiteObservations, name: dealerships.name }).from(websiteObservations).innerJoin(dealerships, eq(dealerships.id, websiteObservations.dealershipId)).orderBy(desc(websiteObservations.timestamp)).limit(30);
    const seen = new Set<string>();
    const latest = rows.filter((r) => (seen.has(r.o.dealershipId) ? false : (seen.add(r.o.dealershipId), true)));
    return (
      <Panel title="Latest website findings, one row per dealership">
        {latest.length === 0 ? (
          <Empty>No websites scanned yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Dealership</th>
                  <th>Scanned</th>
                  <th>Chat widget</th>
                  <th>Lead forms</th>
                  <th>Inventory</th>
                  <th>Service booking</th>
                  <th>Mobile</th>
                  <th>Automation gaps</th>
                </tr>
              </thead>
              <tbody>
                {latest.map(({ o, name }) => {
                  const gaps = [!o.chatPresent ? "no chat" : null, o.leadFormCount === 0 ? "no lead form" : null, o.inventoryAlertsPresent === false ? "no inventory alerts" : null, o.service && !o.service.smsOptionVisible ? "no service text option" : null, o.service?.schedulerMode === "NONE" ? "no online scheduler" : null].filter(Boolean);
                  return (
                    <tr key={o.id}>
                      <td>
                        <A href={`/dealerships/${o.dealershipId}`}>{name}</A>
                      </td>
                      <td className="whitespace-nowrap text-[12.5px] text-muted">{fmtDate(o.timestamp, true)}</td>
                      <td>{o.websiteStatus !== "OK" ? <Badge tone="warn">{label(o.websiteStatus)}</Badge> : o.chatPresent ? `Yes · ${o.chatVendor ?? "unrecognised"}` : "No"}</td>
                      <td className="num">{o.websiteStatus === "OK" ? o.leadFormCount : "—"}</td>
                      <td>{o.inventoryPagePresent ? `Found${o.inventoryCount !== null ? ` · ${o.inventoryCount}` : ""}` : "Not found"}</td>
                      <td>{o.service ? label(o.service.schedulerMode) : o.servicePagePresent ? "Page only" : "Not found"}</td>
                      <td>{o.mobileFriendly === null ? "—" : o.mobileFriendly ? "OK" : "Issue"}</td>
                      <td className="text-[12.5px]">{gaps.join(", ") || <span className="text-muted">none seen</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    );
  }
  if (agent.key === "charlie" || agent.key === "echo") {
    const rows = await db().select({ i: testInteractions, name: dealerships.name }).from(testInteractions).innerJoin(dealerships, eq(dealerships.id, testInteractions.dealershipId)).orderBy(desc(testInteractions.createdAt)).limit(30);
    return (
      <Panel title={agent.key === "charlie" ? "Tests run" : "Tests being watched and their replies"}>
        {rows.length === 0 ? (
          <Empty>No tests yet.</Empty>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Dealership</th>
                <th>Type</th>
                <th>Status</th>
                <th>Submitted</th>
                <th>First reply</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ i, name }) => (
                <tr key={i.id}>
                  <td>
                    <A href={`/dealerships/${i.dealershipId}#interactions`}>{name}</A>
                  </td>
                  <td>{i.testType === "CHAT" ? "Chat" : `${label(i.formType ?? "form")} form`}</td>
                  <td>
                    <Badge tone={i.status === "MONITORING" ? "warn" : i.status === "COMPLETED" ? "good" : i.status === "FAILED" || i.status === "BLOCKED" ? "bad" : "neutral"}>{label(i.status)}</Badge>
                  </td>
                  <td className="whitespace-nowrap text-[12.5px] text-muted">{fmtDate(i.submittedAt, true)}</td>
                  <td className="whitespace-nowrap">{i.firstResponseSeconds !== null ? formatDuration(i.firstResponseSeconds) : i.status === "MONITORING" && i.submittedAt ? <Elapsed since={i.submittedAt} className="text-warn" /> : "—"}</td>
                  <td className="max-w-[360px] text-[12.5px] text-muted">{i.statusDetail ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    );
  }
  if (agent.key === "sage") {
    const rows = await db().select({ s: socialObservations, name: dealerships.name }).from(socialObservations).innerJoin(dealerships, eq(dealerships.id, socialObservations.dealershipId)).orderBy(desc(socialObservations.observedAt)).limit(40);
    return (
      <Panel title="Social observations">
        {rows.length === 0 ? (
          <Empty>Nothing observed yet.</Empty>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Dealership</th>
                <th>Platform</th>
                <th className="text-right">Followers</th>
                <th className="text-right">Posts</th>
                <th className="text-right">Questions</th>
                <th className="text-right">Unanswered</th>
                <th>Observation</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ s, name }) => (
                <tr key={s.id}>
                  <td>
                    <A href={`/dealerships/${s.dealershipId}#social`}>{name}</A>
                  </td>
                  <td>{label(s.platform)}</td>
                  <td className="num text-right">{s.followers ?? "—"}</td>
                  <td className="num text-right">{s.totalPosts ?? s.postsLast30Days ?? "—"}</td>
                  <td className="num text-right">{s.customerQuestions ?? "—"}</td>
                  <td className="num text-right">{s.unansweredQuestions ?? "—"}</td>
                  <td className="max-w-[360px] text-[12.5px] text-muted">
                    {s.notes}
                    {s.sourceUrl ? (
                      <>
                        {" "}
                        <ExternalLink href={s.sourceUrl}>source</ExternalLink>
                      </>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap text-[12px] text-muted">{fmtDate(s.observedAt, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    );
  }
  if (agent.key === "hunter") {
    const rows = await db().select({ s: signals, name: dealerships.name }).from(signals).leftJoin(dealerships, eq(dealerships.id, signals.dealershipId)).orderBy(desc(signals.detectedAt)).limit(40);
    return (
      <Panel title="Signals found">
        {rows.length === 0 ? (
          <Empty>No signals yet.</Empty>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Dealership</th>
                <th>Signal</th>
                <th>Type</th>
                <th>Evidence</th>
                <th>Source</th>
                <th>Seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ s, name }) => (
                <tr key={s.id}>
                  <td>{s.dealershipId ? <A href={`/dealerships/${s.dealershipId}#signals`}>{name}</A> : "Group"}</td>
                  <td>{s.title}</td>
                  <td className="whitespace-nowrap">{label(s.type)}</td>
                  <td>
                    <Provenance kind={s.kind} confidence={s.confidence} />
                  </td>
                  <td>
                    <ExternalLink href={s.sourceUrl}>{label(s.source)}</ExternalLink>
                  </td>
                  <td className="whitespace-nowrap text-[12px] text-muted">{fmtDate(s.detectedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    );
  }
  if (agent.key === "atlas") {
    const rows = await db().select({ d: dealerships }).from(dealerships).orderBy(desc(dealerships.priorityScore)).limit(30);
    const ids = rows.map((r) => r.d.id);
    const scoreRows = ids.length ? await db().select().from(scores).where(inArray(scores.dealershipId, ids)) : [];
    const findingRows = ids.length ? await db().select().from(findings).where(inArray(findings.dealershipId, ids)) : [];
    return (
      <Panel title="Scores, with what each rests on">
        {rows.length === 0 ? (
          <Empty>No dealerships yet.</Empty>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Dealership</th>
                <th className="text-right">Priority</th>
                <th className="text-right">SummaryBot</th>
                <th className="text-right">Inventory</th>
                <th className="text-right">Service</th>
                <th className="text-right">Social</th>
                <th>Recommended</th>
                <th>Observed / inferred</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ d }) => {
                const own = scoreRows.filter((s) => s.dealershipId === d.id);
                const f = findingRows.filter((x) => x.dealershipId === d.id);
                const get = (p: string) => own.find((s) => s.product === p)?.score ?? 0;
                return (
                  <tr key={d.id}>
                    <td>
                      <A href={`/dealerships/${d.id}#scores`}>{d.name}</A>
                    </td>
                    <td className="num text-right font-medium">{d.priorityScore}</td>
                    <td className="num text-right">{get("SUMMARYBOT")}</td>
                    <td className="num text-right">{get("INVENTORY_OUTREACH")}</td>
                    <td className="num text-right">{get("SERVICE_BOT")}</td>
                    <td className="num text-right">{get("SOCIAL_AUTOMATION")}</td>
                    <td>{d.recommendedProduct ? PRODUCT_LABEL[d.recommendedProduct] : "—"}</td>
                    <td className="num text-[12px] text-muted">
                      {f.filter((x) => x.kind === "OBSERVED").length} / {f.filter((x) => x.kind === "INFERENCE").length}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>
    );
  }
  if (agent.key === "blaze") {
    const rows = await db().select({ b: salesBriefs, name: dealerships.name }).from(salesBriefs).innerJoin(dealerships, eq(dealerships.id, salesBriefs.dealershipId)).orderBy(desc(salesBriefs.generatedAt)).limit(30);
    const seen = new Set<string>();
    const latest = rows.filter((r) => (seen.has(r.b.dealershipId) ? false : (seen.add(r.b.dealershipId), true)));
    return (
      <Panel title="Briefs on file" action={<A href="/intel">Open Sales Intelligence</A>}>
        {latest.length === 0 ? (
          <Empty>No briefs yet.</Empty>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Dealership</th>
                <th className="text-right">Priority</th>
                <th>Product</th>
                <th>Main problem</th>
                <th className="text-right">Claims</th>
                <th>Angle by</th>
                <th>Built</th>
              </tr>
            </thead>
            <tbody>
              {latest.map(({ b, name }) => (
                <tr key={b.id}>
                  <td>
                    <A href={`/intel#${b.dealershipId}`}>{name}</A>
                  </td>
                  <td className="num text-right">{b.priorityScore}</td>
                  <td>{b.recommendedProduct ? PRODUCT_LABEL[b.recommendedProduct] : "—"}</td>
                  <td className="max-w-[320px] text-[12.5px]">{b.mainProblem ?? "—"}</td>
                  <td className="num text-right">{b.claims.length}</td>
                  <td>{b.angleSource === "AI" ? "AI" : "Template"}</td>
                  <td className="whitespace-nowrap text-[12px] text-muted">{fmtDate(b.generatedAt, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    );
  }
  if (agent.key === "orion") {
    return (
      <Panel title="Orchestration">
        <p className="px-4 py-3 text-[13px] text-muted">
          SarvX&apos;s findings are the state of the queues. See <A href="/active">Active research</A> for what is running, queued and parked, and <A href="/agents?view=table">the agent table</A> for 7-day throughput per queue.
        </p>
      </Panel>
    );
  }
  // sentinel: every stored estimate, newest first
  const est = await db()
    .select({ id: dealerships.id, name: dealerships.name, unitsLow: dealerships.estUnitsLow, unitsHigh: dealerships.estUnitsHigh, grossLow: dealerships.estProfitLow, grossHigh: dealerships.estProfitHigh, perUnit: dealerships.estProfitPerUnit, segment: dealerships.estSegment, confidence: dealerships.estConfidence, method: dealerships.estMethod, onHand: dealerships.inventoryCount, at: dealerships.estAt })
    .from(dealerships)
    .where(isNotNull(dealerships.estAt))
    .orderBy(desc(dealerships.estAt))
    .limit(200);
  return (
    <Panel title="Estimates">
      {est.length === 0 ? (
        <Empty>No estimates yet. Each dealership gets one after its first inventory read.</Empty>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Dealership</th>
              <th className="text-right">On the lot</th>
              <th className="text-right">Sold a month</th>
              <th className="text-right">Gross profit a month</th>
              <th className="text-right">Per vehicle</th>
              <th>Basis</th>
              <th>Estimated</th>
            </tr>
          </thead>
          <tbody>
            {est.map((r) => (
              <tr key={r.id}>
                <td>
                  <A href={`/dealerships/${r.id}#volume`}>{r.name}</A>
                </td>
                <td className="num text-right">{r.onHand ?? "—"}</td>
                <td className="num text-right">{r.unitsLow !== null ? `${r.unitsLow}–${r.unitsHigh}` : "not countable"}</td>
                <td className="num text-right">{r.grossLow !== null && r.grossHigh !== null ? `${fmtUsd(r.grossLow)} – ${fmtUsd(r.grossHigh)}` : "—"}</td>
                <td className="num text-right">{r.perUnit !== null ? fmtUsd(r.perUnit) : "—"}</td>
                <td>{r.unitsLow !== null ? `${r.method === "TURNOVER" ? "turnover" : "lot size"} · ${label(r.confidence ?? "LOW")}${r.segment ? ` · ${r.segment.toLowerCase()}` : ""}` : "lot could not be counted"}</td>
                <td className="whitespace-nowrap text-[12.5px] text-muted">{fmtDate(r.at, true)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

/** Every dealership Charlie has called, newest first, with the recording where one was kept. */
async function phoneCalls() {
  const called = await db()
    .select({ id: dealerships.id, name: dealerships.name, receptionist: dealerships.receptionist, note: dealerships.receptionistNote, heard: dealerships.receptionistTranscript, at: dealerships.receptionistCheckedAt })
    .from(dealerships)
    .where(isNotNull(dealerships.receptionistCheckedAt))
    .orderBy(desc(dealerships.receptionistCheckedAt))
    .limit(60);
  const callAudio = called.length ? await db().select().from(evidence).where(and(inArray(evidence.dealershipId, called.map((c) => c.id)), eq(evidence.type, "CALL"))).orderBy(desc(evidence.capturedAt)) : [];
  return { called, callAudio };
}

/** One phone check: the verdict, the words heard, and the recording. */
function CallBlock({ call, audio, color }: { call: Awaited<ReturnType<typeof phoneCalls>>["called"][number] | undefined; audio: typeof evidence.$inferSelect | undefined; color: string }) {
  if (!call) return null;
  const tone = call.receptionist === "AI_RECEPTIONIST" ? "warn" : call.receptionist === "HUMAN" ? "good" : call.receptionist === "UNKNOWN" ? "neutral" : "bad";
  return (
    <div className="grid gap-3 px-4 py-3 xl:grid-cols-[1fr_minmax(280px,38%)]">
      <div>
        <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[13px]">
          <Badge tone={tone}>{RECEPTIONIST_LABEL[call.receptionist]}</Badge>
          <span className="font-medium">Phone call</span>
          <span className="text-muted">{call.at ? fmtDate(call.at, true) : ""}</span>
        </div>
        {call.heard ? (
          <blockquote className="rounded-md border border-line bg-charcoal px-3 py-2 text-[13.5px] leading-relaxed text-muted" style={{ borderLeft: `3px solid ${color}` }}>
            <span className="eyebrow block">Heard on the call</span>&ldquo;{call.heard}&rdquo;
          </blockquote>
        ) : (
          <p className="text-[13px] text-muted">{call.note ?? "Nothing was recorded."}</p>
        )}
        {call.heard && call.note ? <p className="mt-1 text-[12px] text-faint">{call.note}</p> : null}
      </div>
      <div>
        <div className="eyebrow mb-1.5">Recording</div>
        {audio ? <audio controls preload="none" src={`/api/evidence/${audio.id}`} className="w-full" /> : <p className="text-[12.5px] text-muted">{call.receptionist === "HUMAN" ? "None: a person answered, so Charlie hung up before anything was said." : "None kept for this call."}</p>}
      </div>
    </div>
  );
}

async function EvidenceTab({ agent }: { agent: (typeof AGENTS)[AgentKey] }) {
  if (agent.key === "charlie" || agent.key === "echo") {
    const tests = await db()
      .select({ i: testInteractions, name: dealerships.name })
      .from(testInteractions)
      .innerJoin(dealerships, eq(dealerships.id, testInteractions.dealershipId))
      .where(inArray(testInteractions.status, ["RUNNING", "MONITORING", "COMPLETED", "FAILED", "BLOCKED"]))
      .orderBy(desc(testInteractions.createdAt))
      .limit(40);
    const ids = tests.map((t) => t.i.id);
    const [lines, shots] = ids.length
      ? await Promise.all([
          db().select().from(transcriptMessages).where(inArray(transcriptMessages.interactionId, ids)).orderBy(transcriptMessages.timestamp),
          db().select().from(evidence).where(inArray(evidence.interactionId, ids)).orderBy(evidence.capturedAt),
        ])
      : [[], []];
    const byDealer = new Map<string, { id: string; own: typeof tests }>();
    for (const t of tests) {
      const g = byDealer.get(t.name) ?? { id: t.i.dealershipId, own: [] };
      g.own.push(t);
      byDealer.set(t.name, g);
    }
    const { called, callAudio } = agent.key === "charlie" ? await phoneCalls() : { called: [], callAudio: [] };
    for (const c of called) if (!byDealer.has(c.name)) byDealer.set(c.name, { id: c.id, own: [] });
    if (byDealer.size === 0)
      return (
        <Panel title="Evidence">
          <Empty>No calls, chats or form interactions yet. Each one will show here with what was heard or said and the recordings and screenshots taken along the way.</Empty>
        </Panel>
      );
    const groups = [...byDealer.entries()].sort(([, a], [, b]) => {
      const last = (g: { id: string; own: typeof tests }) => Math.max(g.own[0]?.i.createdAt.getTime() ?? 0, called.find((c) => c.id === g.id)?.at?.getTime() ?? 0);
      return last(b) - last(a);
    });
    return (
      <div className="space-y-4">
        {groups.map(([name, { id, own }]) => (
          <Panel key={name} title={<span className="normal-case tracking-normal">{name} <span className="font-normal text-muted">· {[called.some((c) => c.id === id) ? "1 call" : null, own.length ? `${own.length} chat or form test${own.length === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ")}</span></span>} action={<A href={`/dealerships/${id}#interactions`}>Open dealership</A>}>
            <CallBlock call={called.find((c) => c.id === id)} audio={callAudio.find((e) => e.dealershipId === id)} color={agent.color} />
            <div className="divide-y divide-line-soft">
              {own.map(({ i }) => {
                const convo = lines.filter((l) => l.interactionId === i.id);
                const pics = shots.filter((e) => e.interactionId === i.id);
                return (
                  <div key={i.id} className="grid gap-4 p-4 xl:grid-cols-[1fr_minmax(280px,38%)]">
                    <div>
                      <div className="mb-2 flex flex-wrap items-center gap-2 text-[13px]">
                        <Badge tone={i.status === "MONITORING" ? "warn" : i.status === "COMPLETED" ? "good" : i.status === "FAILED" || i.status === "BLOCKED" ? "bad" : "neutral"}>{label(i.status)}</Badge>
                        <span className="font-medium">{i.testType === "CHAT" ? "Chatbot conversation" : `${label(i.formType ?? "form")} form`}</span>
                        <span className="text-muted">{i.submittedAt ? `sent ${fmtDate(i.submittedAt, true)}` : `requested ${fmtDate(i.createdAt, true)}`}</span>
                        {i.firstResponseSeconds !== null ? <span className="text-good">first reply {formatDuration(i.firstResponseSeconds)}</span> : i.status === "MONITORING" && i.submittedAt ? <span className="text-warn">waiting <Elapsed since={i.submittedAt} /></span> : null}
                      </div>
                      {convo.length === 0 ? (
                        <p className="text-[13px] text-muted">{i.statusDetail ?? "No transcript recorded."}</p>
                      ) : (
                        <ol className="flex flex-col gap-1.5">
                          {convo.map((l) => (
                            <li key={l.id} className={`max-w-[88%] rounded-md px-3 py-1.5 text-[13.5px] leading-snug ${l.speaker === "RESEARCHER" ? "self-end" : l.speaker === "DEALERSHIP" ? "self-start border border-line bg-charcoal-2" : "self-center text-[12px] text-muted"}`} style={l.speaker === "RESEARCHER" ? { background: agent.color, color: "#06080f" } : undefined}>
                              <span className="num mr-2 text-[10px] uppercase tracking-[0.1em] opacity-70">{l.speaker === "RESEARCHER" ? "Charlie" : l.speaker === "DEALERSHIP" ? "Dealership" : "System"} · {fmtDate(l.timestamp, true).split(", ").pop()}</span>
                              <span className="whitespace-pre-wrap">{l.message}</span>
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                    <div>
                      <div className="eyebrow mb-1.5">Screenshots · {pics.length}</div>
                      {pics.length === 0 ? (
                        <p className="text-[12.5px] text-muted">{i.testType === "CHAT" ? "None captured for this conversation." : "None captured for this submission."}</p>
                      ) : (
                        <div className="grid grid-cols-2 gap-2">
                          {pics.map((e, n) => (
                            <a key={e.id} href={`/api/evidence/${e.id}`} target="_blank" rel="noreferrer" className="block border border-line hover:border-text">
                              {/* eslint-disable-next-line @next/next/no-img-element -- authenticated evidence route */}
                              {e.contentType?.startsWith("audio/") ? <audio controls preload="none" src={`/api/evidence/${e.id}`} className="w-full" /> : <img src={`/api/evidence/${e.id}`} alt={`${label(e.type)} screenshot ${n + 1}`} loading="lazy" className="aspect-[3/2] w-full object-cover object-top" />}
                              <div className="px-1.5 py-1 text-[11px] text-muted">
                                {n + 1}. {label(e.type)} · {fmtDate(e.capturedAt, true).split(", ").pop()}
                              </div>
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>
        ))}
      </div>
    );
  }
  const types = agent.key === "nova" ? (["HOMEPAGE", "INVENTORY", "FORM", "SERVICE"] as const) : agent.key === "sage" ? (["SOCIAL"] as const) : null;
  if (types) {
    const shots = await db().select({ e: evidence, name: dealerships.name }).from(evidence).innerJoin(dealerships, eq(dealerships.id, evidence.dealershipId)).where(inArray(evidence.type, [...types])).orderBy(desc(evidence.capturedAt)).limit(120);
    const byDealer = new Map<string, typeof shots>();
    for (const s of shots) byDealer.set(s.name, [...(byDealer.get(s.name) ?? []), s]);
    if (shots.length === 0)
      return (
        <Panel title="Screenshots">
          <Empty>No screenshots yet.</Empty>
        </Panel>
      );
    return (
      <div className="space-y-4">
        {[...byDealer.entries()].map(([name, own]) => (
          <ShotGrid key={name} title={name} shots={own} dealershipId={own[0]!.e.dealershipId} />
        ))}
      </div>
    );
  }
  return (
    <Panel title="Evidence">
      <p className="px-4 py-3 text-[13px] text-muted">
        {agent.key === "hunter" ? "Hunter's evidence is the source link on each signal (Findings tab)." : agent.key === "atlas" ? "Atlas's evidence is the reasons behind each score; open a dealership's Scores section to see every rule and the record it points at." : agent.key === "blaze" ? "Blaze's evidence is the claim list under each brief in Sales Intelligence." : "Sentinel's evidence is the inventory snapshots behind each estimate: open a dealership's Inventory history to see every read, its listing count and asking prices."}{" "}
        <A href={agent.key === "sentinel" ? "/opportunities" : agent.key === "blaze" ? "/intel" : "/evidence"}>Open</A>
      </p>
    </Panel>
  );
}

function ShotGrid({ title, shots, dealershipId }: { title: string; shots: { e: typeof evidence.$inferSelect; name: string }[]; dealershipId: string }) {
  const latest = shots[0]?.e.capturedAt;
  return (
    <Panel title={<span className="normal-case tracking-normal">{title} <span className="font-normal text-muted">· {shots.length} screenshot{shots.length === 1 ? "" : "s"}{latest ? ` · latest ${fmtDate(latest, true)}` : ""}</span></span>} action={<A href={`/evidence?dealership=${dealershipId}`}>In the library</A>}>
      <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4 xl:grid-cols-6">
        {shots.map(({ e }) => (
          <a key={e.id} href={`/api/evidence/${e.id}`} target="_blank" rel="noreferrer" className="block border border-line hover:border-text">
            {/* eslint-disable-next-line @next/next/no-img-element -- authenticated evidence route */}
            {e.contentType?.startsWith("audio/") ? <audio controls preload="none" src={`/api/evidence/${e.id}`} className="w-full" /> : <img src={`/api/evidence/${e.id}`} alt={`${label(e.type)} screenshot for ${title}`} loading="lazy" className="aspect-[3/2] w-full object-cover object-top" />}
            <div className="px-1.5 py-1 text-[11.5px] text-muted">
              <div className="truncate text-text">{label(e.type)}</div>
              {fmtDate(e.capturedAt, true)}
            </div>
          </a>
        ))}
      </div>
    </Panel>
  );
}

function History({ agent, history }: { agent: (typeof AGENTS)[AgentKey]; history: Awaited<ReturnType<typeof agentHistory>> }) {
  return (
    <Panel title="Previous tasks" action={<A href={`/jobs${agent.queues.length ? `?queue=${agent.queues[0]}` : ""}`}>All job runs</A>}>
      {history.length === 0 ? (
        <Empty>{agent.queues.length ? "No tasks have run yet." : agent.key === "orion" ? "Orion schedules work for the other agents rather than running tasks itself; its scheduler ticks are in Live activity and the jobs it created are in each agent's History." : "Sentinel acts through rules rather than scheduled tasks; every decision is in its Live activity and the audit log."}</Empty>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Started</th>
              <th>Task</th>
              <th>Dealership</th>
              <th>Outcome</th>
              <th className="text-right">Duration</th>
              <th className="text-right">AI cost</th>
              <th>Result</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id}>
                <td className="num whitespace-nowrap text-[12.5px]">{fmtDate(h.startedAt, true)}</td>
                <td className="num text-[12.5px]">{h.queue}</td>
                <td>{h.dealershipId ? <A href={`/dealerships/${h.dealershipId}`}>{h.dealershipName}</A> : "—"}</td>
                <td>
                  <Badge tone={h.status === "FAILED" ? "bad" : h.status === "COMPLETED" ? "good" : h.status === "RUNNING" ? "warn" : "neutral"}>{h.status}</Badge>
                </td>
                <td className="num text-right">{h.durationMs !== null ? `${(h.durationMs / 1000).toFixed(1)}s` : "—"}</td>
                <td className="num text-right">{h.aiCostUsd ? `$${h.aiCostUsd.toFixed(3)}` : "—"}</td>
                <td className={`max-w-[380px] text-[12.5px] ${h.error ? "text-bad" : "text-muted"}`}>{h.error ?? h.result ?? ""}</td>
                <td className="whitespace-nowrap">{h.status !== "RUNNING" ? <A href={`/agents/${agent.key}?tab=history&replay=${h.id}`}>Replay</A> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function Configuration({ agent, settings, admin }: { agent: (typeof AGENTS)[AgentKey]; settings: Awaited<ReturnType<typeof getSettings>>; admin: boolean }) {
  const rows: [string, string][] =
    agent.key === "nova"
      ? [
          ["Website scan every", `${settings.websiteScanIntervalDays} days`],
          ["Inventory check every", `${settings.inventoryScanIntervalDays} days`],
          ["Research hours", settings.researchWindowEnabled ? `${settings.researchWindowStart}–${settings.researchWindowEnd} ${settings.timezone}` : "Around the clock"],
          ["Pages per scan", "CRAWLER_MAX_PAGES (server env)"],
        ]
      : agent.key === "charlie"
        ? [
            ["Controlled tests", settings.testingEnabled ? "Allowed" : "Off"],
            ["Cooldown per test type", `${settings.interactionCooldownDays} days (30 minimum)`],
            ["Max chat messages", String(settings.maxChatMessages)],
            ["Reply monitoring window", `${settings.responseMonitorHours} hours`],
          ]
        : agent.key === "sage"
          ? [["Social check every", `${settings.socialScanIntervalDays} days`]]
          : agent.key === "hunter"
            ? [["Careers check every", `${settings.signalScanIntervalDays} days`]]
            : agent.key === "atlas"
              ? [["Scoring rules", "Weights and thresholds in Settings → Scoring rules"]]
              : agent.key === "blaze"
                ? [
                    ["AI provider", settings.aiProvider === "env" ? "From server env" : settings.aiProvider],
                    ["AI requests per brief", String(settings.maxAIRequestsPerJob)],
                  ]
                : agent.key === "orion"
                  ? [
                      ["Research hours", settings.researchWindowEnabled ? `${settings.researchWindowStart}–${settings.researchWindowEnd} ${settings.timezone}` : "Around the clock"],
                      ["Scheduler tick", "Every 5 minutes"],
                      ["Worker concurrency", "WORKER_CONCURRENCY (server env)"],
                    ]
                  : agent.key === "echo"
                    ? [
                        ["Reply monitoring window", `${settings.responseMonitorHours} hours`],
                        ["Milestones", "5 min · 15 min · 1 h · 4 h · 24 h · 72 h"],
                        ["Inbound webhooks", "/api/webhooks/sms · email · phone (shared secret or Twilio signature)"],
                      ]
                    : [
                        ["Cooldown", `${settings.interactionCooldownDays} days per test type`],
                        ["Screenshots kept", `${settings.screenshotRetentionDays} days`],
                        ["Research data kept", `${settings.evidenceRetentionDays} days`],
                        ["Never submitted", "Finance, trade-in, appointment and test-drive forms"],
                      ];
  return (
    <Panel title="Configuration" action={<A href={agent.configHref}>{admin ? "Edit" : "View"} in settings</A>}>
      <dl className="grid gap-x-6 gap-y-2 px-4 py-3 text-[13px] md:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[180px_1fr] gap-2">
            <dt className="text-muted">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

/**
 * Everything this agent has done, organised per dealership: each task it ran there with every
 * recorded step, plus (for Charlie and Echo) the conversations. Newest dealership first.
 */
async function DealershipHistory({ agent }: { agent: (typeof AGENTS)[AgentKey] }) {
  const queues = agent.queues;
  const runs = queues.length
    ? await db()
        .select({ r: jobRuns, name: dealerships.name })
        .from(jobRuns)
        .innerJoin(dealerships, eq(dealerships.id, jobRuns.dealershipId))
        .where(inArray(jobRuns.queue, [...queues]))
        .orderBy(desc(jobRuns.startedAt))
        .limit(120)
    : [];
  const runIds = runs.map((x) => x.r.id);
  const steps = runIds.length ? await db().select().from(agentEvents).where(and(eq(agentEvents.agent, agent.key), inArray(agentEvents.jobRunId, runIds))).orderBy(agentEvents.at) : [];
  // Agents without queues (Sentinel) and rule-driven work: events per dealership.
  const loose = await db()
    .select({ e: agentEvents, name: dealerships.name })
    .from(agentEvents)
    .innerJoin(dealerships, eq(dealerships.id, agentEvents.dealershipId))
    .where(and(eq(agentEvents.agent, agent.key), isNull(agentEvents.jobRunId)))
    .orderBy(desc(agentEvents.at))
    .limit(120);
  const convo = agent.key === "charlie" || agent.key === "echo" ? await db().select({ t: transcriptMessages, name: dealerships.name }).from(transcriptMessages).innerJoin(dealerships, eq(dealerships.id, transcriptMessages.dealershipId)).orderBy(transcriptMessages.timestamp).limit(300) : [];
  const { called, callAudio } = agent.key === "charlie" ? await phoneCalls() : { called: [], callAudio: [] };

  type Entry = { at: Date; kind: "run" | "event"; run?: (typeof runs)[number]["r"]; event?: typeof agentEvents.$inferSelect };
  const byDealer = new Map<string, { id: string; name: string; entries: Entry[] }>();
  const bucket = (id: string, name: string) => {
    if (!byDealer.has(id)) byDealer.set(id, { id, name, entries: [] });
    return byDealer.get(id)!;
  };
  for (const { r, name } of runs) if (r.dealershipId) bucket(r.dealershipId, name).entries.push({ at: r.startedAt, kind: "run", run: r });
  for (const { e, name } of loose) if (e.dealershipId) bucket(e.dealershipId, name).entries.push({ at: e.at, kind: "event", event: e });
  const dealers = [...byDealer.values()].map((d) => ({ ...d, entries: d.entries.sort((a, b) => b.at.getTime() - a.at.getTime()) })).sort((a, b) => (b.entries[0]?.at.getTime() ?? 0) - (a.entries[0]?.at.getTime() ?? 0));

  if (dealers.length === 0)
    return (
      <Panel title="By dealership">
        <Empty>{agent.name} has not worked on a dealership yet.</Empty>
      </Panel>
    );
  return (
    <div className="space-y-4">
      {dealers.map((d) => {
        const lines = convo.filter((c) => c.t.dealershipId === d.id);
        const taskCount = d.entries.filter((e) => e.kind === "run").length;
        return (
          <Panel key={d.id} title={<span className="normal-case tracking-normal">{d.name} <span className="font-normal text-muted">· {taskCount ? `${taskCount} task${taskCount === 1 ? "" : "s"}` : `${d.entries.length} decision${d.entries.length === 1 ? "" : "s"}`} · last {fmtDate(d.entries[0]!.at, true)}</span></span>} action={<A href={`/dealerships/${d.id}`}>Open dealership</A>}>
            <div className="divide-y divide-line-soft">
              {d.entries.slice(0, 12).map((en) =>
                en.kind === "run" && en.run ? (
                  <details key={en.run.id} className="group px-4 py-2" open={en === d.entries[0]}>
                    <summary className="flex cursor-pointer flex-wrap items-center gap-3 text-[13.5px]">
                      <Badge tone={en.run.status === "FAILED" ? "bad" : en.run.status === "COMPLETED" ? "good" : en.run.status === "RUNNING" ? "warn" : "neutral"}>{en.run.status}</Badge>
                      <span className="num" style={{ color: agent.color }}>{en.run.queue}</span>
                      <span className="text-muted">{fmtDate(en.run.startedAt, true)}</span>
                      {en.run.durationMs !== null ? <span className="num text-muted">{(en.run.durationMs / 1000).toFixed(1)}s</span> : null}
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">{en.run.error ?? en.run.result ?? ""}</span>
                      <A href={`/agents/${agent.key}?tab=history&replay=${en.run.id}`}>Replay</A>
                    </summary>
                    <ol className="mt-2 space-y-1 border-l border-line pl-3 text-[13px]">
                      {steps.filter((st) => st.jobRunId === en.run!.id).map((st) => (
                        <li key={st.id} className="grid grid-cols-[64px_1fr] gap-2">
                          <span className="num text-[11.5px] text-muted">{st.at.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</span>
                          <span className={st.status === "ERROR" ? "text-bad" : st.status === "BLOCKED" ? "text-warn" : ""}>
                            {st.step}
                            {st.evidenceId ? (
                              <>
                                {" "}
                                <a href={`/api/evidence/${st.evidenceId}`} target="_blank" rel="noreferrer" className="text-blue-light hover:underline">
                                  view
                                </a>
                              </>
                            ) : null}
                            {st.detail ? <span className="block break-words text-[12px] text-faint">{st.detail}</span> : null}
                          </span>
                        </li>
                      ))}
                      {steps.filter((st) => st.jobRunId === en.run!.id).length === 0 ? <li className="text-[12.5px] text-muted">No step detail was recorded for this task.</li> : null}
                    </ol>
                  </details>
                ) : en.event ? (
                  <div key={en.event.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-[13.5px]">
                    <Badge tone={en.event.status === "BLOCKED" ? "bad" : en.event.status === "DONE" ? "good" : "neutral"}>{en.event.status === "BLOCKED" ? "Blocked" : en.event.status === "DONE" ? "Allowed" : "Note"}</Badge>
                    <span>{en.event.step}</span>
                    <span className="text-muted">{fmtDate(en.event.at, true)}</span>
                    {en.event.detail ? <span className="w-full text-[12.5px] text-faint">{en.event.detail}</span> : null}
                  </div>
                ) : null,
              )}
              {d.entries.length > 12 ? <div className="px-4 py-2 text-[12.5px] text-muted">{d.entries.length - 12} older item(s) in <A href={`/activity?agent=${agent.key}&dealership=${d.id}`}>Activity History</A>.</div> : null}
            </div>
            {called.some((c) => c.id === d.id) ? (
              <div className="border-t border-line">
                <CallBlock call={called.find((c) => c.id === d.id)} audio={callAudio.find((e) => e.dealershipId === d.id)} color={agent.color} />
              </div>
            ) : null}
            {lines.length ? (
              <div className="border-t border-line px-4 py-3">
                <div className="eyebrow mb-1.5">Chatbot conversation</div>
                <ol className="flex flex-col gap-1.5">
                  {lines.slice(-12).map(({ t }) => (
                    <li key={t.id} className={`max-w-[88%] rounded-md px-3 py-1.5 text-[13.5px] leading-snug ${t.speaker === "RESEARCHER" ? "self-end" : t.speaker === "DEALERSHIP" ? "self-start border border-line bg-charcoal-2" : "self-center text-[12px] text-muted"}`} style={t.speaker === "RESEARCHER" ? { background: agent.color, color: "#06080f" } : undefined}>
                      <span className="num mr-2 text-[10px] uppercase tracking-[0.1em] opacity-70">{t.speaker === "RESEARCHER" ? "Charlie" : t.speaker === "DEALERSHIP" ? "Dealership" : "System"} · {fmtDate(t.timestamp, true).split(", ").pop()}</span>
                      <span className="whitespace-pre-wrap">{t.message}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </Panel>
        );
      })}
    </div>
  );
}
