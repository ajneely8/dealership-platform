import { avg, count, eq, gte, sql, sum } from "drizzle-orm";
import { setAgentPaused } from "@/app/actions";
import { AgentCards, DemoBanner } from "@/components/agents/command";
import { AgentStreamProvider } from "@/components/agents/stream";
import { agentEventsFor, allAgentsLive, toFeed, toSnapshot } from "@/lib/agent-state";
import { A, Badge, Empty, Flash, PageHeader, Panel, fmtDate, timeAgo } from "@/components/ui";
import { db } from "@/db";
import { jobRuns, testInteractions } from "@/db/schema";
import { QUEUES, type QueueName } from "@/domain/constants";
import { describeWindow, isWithinWindow, nextWindowStart } from "@/domain/research-window";
import { hasRole, requireUser } from "@/lib/auth/session";
import { getSettings } from "@/lib/settings";
import { getQueue } from "@/queue";
import { RESEARCH_QUEUES } from "@/domain/constants";

const AGENT: Record<QueueName, { name: string; does: string }> = {
  prospect: { name: "Prospecting", does: "Finds dealership candidates nearby and screens whether they can be researched" },
  "phone-check": { name: "Phone check", does: "Calls the dealership once and records what answers (Twilio)" },
  discovery: { name: "Discovery", does: "Reads the website's own name, phone, address and brands" },
  "website-scan": { name: "Website Agent", does: "Chat, forms, inventory, service, social links, careers, screenshots" },
  inventory: { name: "Inventory read", does: "Counts the lot and reads asking prices on a cadence" },
  estimate: { name: "Sales estimate", does: "Monthly units and gross sales from the inventory on file" },
  signals: { name: "Hiring / Signal Agent", does: "Growth and intake roles from the careers page" },
  social: { name: "Social Agent", does: "Publicly visible follower and post counts" },
  interaction: { name: "Chat / Form Agent", does: "Approved form submissions and chat questions" },
  "response-check": { name: "Reply monitor", does: "Response-time milestones for live tests (runs 24/7)" },
  scoring: { name: "Scoring Agent", does: "Deterministic product scores and priority" },
  "sales-intel": { name: "Sales Intel Agent", does: "Call brief, angle, opener and discovery question" },
};

export default async function AgentsPage({ searchParams }: { searchParams: Promise<{ notice?: string; error?: string; view?: string; demo?: string }> }) {
  const { notice, error, view, demo: demoParam } = await searchParams;
  if (view !== "table") {
    const demo = demoParam === "1";
    const [agents, events] = await Promise.all([allAgentsLive(), agentEventsFor({ limit: 40 })]);
    return (
      <AgentStreamProvider initialAgents={agents.map(toSnapshot)} initialEvents={events.map(toFeed)} demo={demo}>
        <PageHeader title="AI Agents" sub="Nine specialists. Click one to open its workspace: purpose, live activity, findings, evidence, history and configuration.">
          <A href="/agents?view=table">Throughput table</A>
          <A href={demo ? "/agents" : "/agents?demo=1"}>{demo ? "Exit demo" : "Demo mode"}</A>
        </PageHeader>
        <Flash notice={notice} error={error} />
        <DemoBanner exitHref="/agents" />
        <AgentCards />
      </AgentStreamProvider>
    );
  }
  const user = await requireUser();
  const admin = hasRole(user, "ADMIN");
  const since = new Date(Date.now() - 7 * 86_400_000);
  const [settings, stats, lastRuns, [pending], live] = await Promise.all([
    getSettings(),
    db()
      .select({
        queue: jobRuns.queue,
        completed: sql<number>`count(*) filter (where ${jobRuns.status} = 'COMPLETED')`,
        skipped: sql<number>`count(*) filter (where ${jobRuns.status} = 'SKIPPED')`,
        failed: sql<number>`count(*) filter (where ${jobRuns.status} = 'FAILED')`,
        avgMs: avg(jobRuns.durationMs),
        aiRequests: sum(jobRuns.aiRequests),
        aiCost: sum(jobRuns.aiCostUsd),
        total: count(),
      })
      .from(jobRuns)
      .where(gte(jobRuns.startedAt, since))
      .groupBy(jobRuns.queue),
    db().select({ queue: jobRuns.queue, at: sql<Date>`max(${jobRuns.startedAt})` }).from(jobRuns).groupBy(jobRuns.queue),
    db().select({ n: count() }).from(testInteractions).where(eq(testInteractions.status, "PENDING_APPROVAL")),
    Promise.all(
      QUEUES.map(async (q) => {
        const queue = getQueue(q);
        const [paused, c] = await Promise.all([queue.isPaused(), queue.getJobCounts("waiting", "active", "delayed", "failed")]);
        return { q, paused, waiting: c.waiting ?? 0, active: c.active ?? 0, delayed: c.delayed ?? 0, failed: c.failed ?? 0 };
      }),
    ),
  ]);
  const cfg = { enabled: settings.researchWindowEnabled, start: settings.researchWindowStart, end: settings.researchWindowEnd, timezone: settings.timezone };
  const now = new Date();
  const open = isWithinWindow(now, cfg);
  const statOf = (q: string) => stats.find((s) => s.queue === q);
  const lastOf = (q: string) => lastRuns.find((l) => l.queue === q)?.at;
  const totalCost = stats.reduce((a, s) => a + Number(s.aiCost ?? 0), 0);
  const totalAi = stats.reduce((a, s) => a + Number(s.aiRequests ?? 0), 0);

  return (
    <>
      <PageHeader title="AI Agents · throughput" sub="Per-queue view: what each agent has done over the last 7 days and what it has cost.">
        <A href="/agents">Back to the agents</A>
        {(pending?.n ?? 0) > 0 ? <A href="/interactions">{pending?.n} test(s) waiting for approval</A> : null}
      </PageHeader>
      <Flash notice={notice} error={error} />

      <Panel title="Research window" className="mb-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-[13px]">
          <Badge tone={open ? "good" : "neutral"}>{open ? "Research running" : "Outside hours"}</Badge>
          <span>{describeWindow(cfg)}.</span>
          {!open && cfg.enabled ? <span className="text-muted">Next opens {fmtDate(nextWindowStart(now, cfg), true)} ({settings.timezone.replace(/_/g, " ")}). Parked jobs resume then; replies are still recorded now.</span> : null}
          <A href="/settings">Change hours</A>
        </div>
      </Panel>

      <Panel title="Agents" action={<span className="num text-[11px] uppercase tracking-[0.08em] text-muted">7 days · {totalAi} AI requests · ${totalCost.toFixed(2)} est.</span>}>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Status</th>
                <th>Last run</th>
                <th className="text-right">Done</th>
                <th className="text-right">Skipped</th>
                <th className="text-right">Failed</th>
                <th className="text-right">Avg time</th>
                <th className="text-right">Queued</th>
                <th className="text-right">Running</th>
                <th className="text-right">Parked</th>
                <th className="text-right">AI cost</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {QUEUES.map((q) => {
                const s = statOf(q);
                const l = live.find((x) => x.q === q)!;
                const honoursWindow = RESEARCH_QUEUES.includes(q);
                return (
                  <tr key={q}>
                    <td className="min-w-[220px]">
                      <div className="font-medium">{AGENT[q].name}</div>
                      <div className="text-[12px] text-muted">{AGENT[q].does}</div>
                      <div className="num text-[10.5px] uppercase tracking-[0.08em] text-faint">{q}{honoursWindow ? " · research hours" : " · 24/7"}</div>
                    </td>
                    <td>{l.paused ? <Badge tone="warn">Paused</Badge> : l.active > 0 ? <Badge tone="blue">Working</Badge> : <Badge tone="good">Ready</Badge>}</td>
                    <td className="whitespace-nowrap text-[12.5px] text-muted">{lastOf(q) ? timeAgo(new Date(lastOf(q)!)) : "never"}</td>
                    <td className="num text-right">{Number(s?.completed ?? 0)}</td>
                    <td className="num text-right">{Number(s?.skipped ?? 0)}</td>
                    <td className={`num text-right ${Number(s?.failed ?? 0) ? "text-bad" : ""}`}>{Number(s?.failed ?? 0)}</td>
                    <td className="num text-right">{s?.avgMs ? `${(Number(s.avgMs) / 1000).toFixed(1)}s` : "—"}</td>
                    <td className="num text-right">{l.waiting}</td>
                    <td className="num text-right">{l.active}</td>
                    <td className="num text-right">{l.delayed}</td>
                    <td className="num text-right">{Number(s?.aiCost ?? 0) > 0 ? `$${Number(s?.aiCost ?? 0).toFixed(3)}` : "—"}</td>
                    <td>
                      {admin ? (
                        <form action={setAgentPaused}>
                          <input type="hidden" name="back" value="/agents" />
                          <input type="hidden" name="queue" value={q} />
                          <input type="hidden" name="paused" value={String(!l.paused)} />
                          <button className="btn btn-sm" type="submit">
                            {l.paused ? "Resume" : "Pause"}
                          </button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {stats.length === 0 ? <Empty>No jobs have run in the last 7 days.</Empty> : null}
        <p className="border-t border-line px-4 py-2 text-[12px] text-muted">
          Pausing an agent stops it from starting new work; anything already running finishes. AI cost is an estimate from token counts at list prices; without an AI provider configured it stays at zero. Failed jobs can be retried on the <A href="/jobs?status=FAILED">Jobs</A> page.
        </p>
      </Panel>
    </>
  );
}
