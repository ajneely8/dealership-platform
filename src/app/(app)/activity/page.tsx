import { AgentFeed } from "@/components/agents/feed";
import { AgentStreamProvider } from "@/components/agents/stream";
import { A, Field, PageHeader, Panel } from "@/components/ui";
import { db } from "@/db";
import { dealerships } from "@/db/schema";
import { AGENTS, AGENT_KEYS, type AgentKey } from "@/domain/agents";
import { agentEventsFor, allAgentsLive, toFeed, toSnapshot } from "@/lib/agent-state";

export default async function ActivityHistoryPage({ searchParams }: { searchParams: Promise<{ agent?: string; dealership?: string }> }) {
  const { agent, dealership } = await searchParams;
  const agentKey = AGENT_KEYS.includes(agent as AgentKey) ? (agent as AgentKey) : undefined;
  const dealershipId = dealership && /^[0-9a-f-]{36}$/i.test(dealership) ? dealership : undefined;
  const [events, dealers, agents] = await Promise.all([agentEventsFor({ agent: agentKey, dealershipId, limit: 150 }), db().select({ id: dealerships.id, name: dealerships.name }).from(dealerships).orderBy(dealerships.name), allAgentsLive()]);
  return (
    <AgentStreamProvider initialAgents={agents.map(toSnapshot)} initialEvents={events.map(toFeed)} agentKey={agentKey} dealershipId={dealershipId}>
      <PageHeader title="Activity History" sub="Every step every agent took, newest first, and still live. Job runs and the audit log hold the rest.">
        <form className="flex items-end gap-2">
          <Field label="Agent">
            <select className="input" name="agent" defaultValue={agentKey ?? ""}>
              <option value="">All agents</option>
              {AGENT_KEYS.map((k) => (
                <option key={k} value={k}>
                  {AGENTS[k].name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Dealership">
            <select className="input min-w-[200px]" name="dealership" defaultValue={dealershipId ?? ""}>
              <option value="">All dealerships</option>
              {dealers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <button className="btn" type="submit">
            Filter
          </button>
          <A href="/jobs">Job runs</A>
          <A href="/audit">Audit log</A>
        </form>
      </PageHeader>
      <Panel>
        <AgentFeed showAgent limit={150} agentKey={agentKey} />
      </Panel>
    </AgentStreamProvider>
  );
}
