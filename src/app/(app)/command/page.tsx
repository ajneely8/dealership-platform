import { DemoBanner, StreamBadge } from "@/components/agents/command";
import { AgentFeed } from "@/components/agents/feed";
import { AgentStreamProvider } from "@/components/agents/stream";
import { WorkforceStage } from "@/components/agents/workforce";
import { A, MetricStrip, PageHeader, Panel } from "@/components/ui";
import { describeWindow, isWithinWindow } from "@/domain/research-window";
import { agentEventsFor, allAgentsLive, commandMetrics, toFeed, toSnapshot } from "@/lib/agent-state";
import { getSettings } from "@/lib/settings";
import { prospectStats } from "@/workers/prospect";
import { queuesAvailable } from "@/queue";
import { currentRelay, RELAY_STAGES } from "@/workers/relay";
import { AGENTS } from "@/domain/agents";

export default async function CommandCenterPage({ searchParams }: { searchParams: Promise<{ demo?: string }> }) {
  const { demo: demoParam } = await searchParams;
  const demo = demoParam === "1";
  const [metrics, agents, events, settings, prospecting, relay] = await Promise.all([commandMetrics(), allAgentsLive(), agentEventsFor({ limit: 40 }), getSettings(), prospectStats(), currentRelay()]);
  const cfg = { enabled: settings.researchWindowEnabled, start: settings.researchWindowStart, end: settings.researchWindowEnd, timezone: settings.timezone };
  const open = isWithinWindow(new Date(), cfg);
  const working = agents.filter((a) => a.status === "WORKING").length;

  return (
    <AgentStreamProvider initialAgents={agents.map(toSnapshot)} initialEvents={events.map(toFeed)} demo={demo}>
      <PageHeader title="Command Center" sub={`${describeWindow(cfg)} · ${open ? "research is running now" : "outside research hours; prospecting, tests and replies continue"}`}>
        <StreamBadge />
        <A href="/prospects">Prospecting</A>
        <A href="/active">Active research</A>
        <A href={demo ? "/command" : "/command?demo=1"}>{demo ? "Exit demo" : "Demo mode"}</A>
        <a className="btn" href="/api/export/daily-list">
          Today&apos;s list (CSV)
        </a>
      </PageHeader>
      <DemoBanner exitHref="/command" />
      {!queuesAvailable() ? (
        <div role="status" className="mb-4 border-l-2 border-blue bg-[#0d1a33] px-3 py-2 text-[13px] text-text">
          <span className="font-medium">Hosted viewer.</span> The agents run on the research machine; everything here is the research as of the last sync. Phone numbers, briefs, estimates and verdicts are live data; buttons that would start a job are off.
        </div>
      ) : null}

      {!demo ? (
        <MetricStrip
          items={[
            { label: "Dealerships", value: metrics.dealerships, hint: "On file" },
            { label: "Found today", value: prospecting.admittedToday, hint: `${prospecting.rejectedToday} turned away · ${prospecting.pool} waiting`, tone: "good" },
            { label: "Relay", value: relay ? `${RELAY_STAGES.indexOf(relay.stage) + 1}/${RELAY_STAGES.length}` : "—", hint: relay ? `${AGENTS[relay.stage].name} has ${relay.name}` : "Nova is free to screen the next dealership" },
            { label: "Researched today", value: metrics.researchedToday, hint: "Website scans completed" },
            { label: "Agents working", value: working, hint: `of ${agents.length}` },
            { label: "Active tasks", value: metrics.runningJobs, hint: "Running right now" },
            { label: "Completed today", value: metrics.completedToday },
            { label: "Awaiting responses", value: metrics.awaitingResponses, hint: "Open live tests" },
            { label: "New opportunities", value: metrics.newOpportunities, hint: "Ready to contact, last 24h" },
            { label: "High priority", value: metrics.highPriority, hint: "Score 70+" },
            { label: "Errors (24h)", value: metrics.failed24h, tone: metrics.failed24h ? "bad" : "default", hint: metrics.failed24h ? "See Jobs" : "None" },
          ]}
        />
      ) : null}

      <div className="mt-5">
        <WorkforceStage />
      </div>

      <Panel title="Live activity" className="mt-5" action={<A href="/activity">Full history</A>}>
        <AgentFeed showAgent limit={30} />
      </Panel>
    </AgentStreamProvider>
  );
}
