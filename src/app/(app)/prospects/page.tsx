import { CurrentTaskBar } from "@/components/agents/feed";
import { AgentStreamProvider } from "@/components/agents/stream";
import { A, Badge, Empty, PageHeader, Panel, fmtDate } from "@/components/ui";
import { agentEventsFor, allAgentsLive, toFeed, toSnapshot } from "@/lib/agent-state";
import { getSettings } from "@/lib/settings";
import { candidatePool, prospectStats, recentProspects } from "@/workers/prospect";
import { currentRelay, RELAY_STAGES } from "@/workers/relay";
import { AGENTS } from "@/domain/agents";

/** What Nova is finding, screening, admitting and turning away — live. */
export default async function ProspectsPage() {
  const [stats, recent, pool, agents, events, settings, relay] = await Promise.all([prospectStats(), recentProspects(80), candidatePool(20), allAgentsLive(), agentEventsFor({ agent: "nova", limit: 10 }), getSettings(), currentRelay()]);
  const relayLine = relay ? ` Right now ${AGENTS[relay.stage].name} has ${relay.name} (${relay.note}; stage ${RELAY_STAGES.indexOf(relay.stage) + 1} of ${RELAY_STAGES.length}); Nova screens the next one when Blaze hands it back.` : " No dealership is mid-relay; Nova screens the next candidate on the next tick.";
  return (
    <AgentStreamProvider initialAgents={agents.map(toSnapshot)} initialEvents={events.map(toFeed)} agentKey="nova">
      <PageHeader title="Prospecting" sub={settings.prospectingEnabled ? `One independent dealership at a time: Nova reads it, Charlie calls and tests the chat, then Sage, Hunter, Atlas and Blaze take their turn before Nova looks at the next (checked every ${settings.prospectIntervalSeconds} seconds${settings.prospectingAroundTheClock ? ", around the clock" : ", during research hours"}). Today: ${stats.admittedToday} admitted, ${stats.rejectedToday} turned away, ${stats.pool} waiting.${relayLine}` : "Prospecting is switched off in Settings."}>
        <A href="/settings">Settings</A>
        <A href="/agents/nova?tab=activity">Nova&apos;s full activity</A>
      </PageHeader>
      <div className="mb-4 overflow-hidden rounded-md border border-line bg-surface">
        <CurrentTaskBar agentKey="nova" />
      </div>
      <div className="space-y-4">
        <Panel title="Screened" action={<A href="/dealerships">Dealerships</A>}>
          {recent.length === 0 ? (
            <Empty>Nothing screened yet. The first candidate is picked up within a minute of the workers starting.</Empty>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Verdict</th>
                  <th>Dealership</th>
                  <th>Where</th>
                  <th>Why</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {recent.map(({ p, dealershipName }) => (
                  <tr key={p.id}>
                    <td>
                      <Badge tone={p.status === "ADMITTED" ? "good" : p.status === "REJECTED" ? "bad" : "warn"}>{p.status === "ADMITTED" ? "Admitted" : p.status === "REJECTED" ? "Turned away" : "Screening"}</Badge>
                    </td>
                    <td>
                      {p.dealershipId ? <A href={`/dealerships/${p.dealershipId}`}>{dealershipName ?? p.name}</A> : <span>{p.name}</span>}
                      <div className="num text-[11.5px] text-muted">{p.normalizedDomain}</div>
                    </td>
                    <td className="whitespace-nowrap text-[12.5px] text-muted">
                      {[p.city, p.state].filter(Boolean).join(", ") || "—"}
                      {p.distanceKm !== null ? <span className="num"> · {Math.round(p.distanceKm)} km</span> : null}
                    </td>
                    <td className="max-w-[360px] text-[12.5px]">{p.reason ?? ""}</td>
                    <td className="num whitespace-nowrap text-[12px] text-muted">{fmtDate(p.screenedAt ?? p.createdAt, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <div>
          <Panel title="Next in line">
            {pool.length === 0 ? (
              <Empty>The pool is empty; Nova will ask OpenStreetMap for more on the next tick, widening the radius if needed.</Empty>
            ) : (
              <ul className="grid gap-x-6 text-[13.5px] md:grid-cols-2 xl:grid-cols-3">
                {pool.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 border-b border-line-soft px-4 py-2">
                    <span className="truncate">{p.name}</span>
                    <span className="num ml-auto shrink-0 text-[11.5px] text-muted">
                      {p.normalizedDomain}
                      {p.distanceKm !== null ? ` · ${Math.round(p.distanceKm)} km` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </AgentStreamProvider>
  );
}
