import { getSessionUser } from "@/lib/auth/session";
import { agentEventsFor, allAgentsLive } from "@/lib/agent-state";

export const dynamic = "force-dynamic";

/** Everything the workforce is doing right now: all agents' statuses plus the latest events. */
export async function GET(req: Request) {
  if (!(await getSessionUser())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const limit = Math.min(200, Math.max(1, Number(new URL(req.url).searchParams.get("limit") ?? 50) || 50));
  const [agents, events] = await Promise.all([allAgentsLive(), agentEventsFor({ limit })]);
  const anyWorking = agents.find((a) => a.current);
  return Response.json({
    status: agents.some((a) => a.status === "WORKING") ? "WORKING" : agents.some((a) => a.status === "WAITING") ? "WAITING" : "IDLE",
    current: anyWorking?.current ? { ...anyWorking.current, startedAt: anyWorking.current.startedAt.toISOString() } : null,
    agents: agents.map((a) => ({ key: a.key, status: a.status, current: a.current ? { dealershipName: a.current.dealershipName, dealershipId: a.current.dealershipId, lastStep: a.current.lastStep, startedAt: a.current.startedAt.toISOString() } : null, waiting: a.waiting })),
    events: events.map((e) => ({ ...e, at: e.at.toISOString() })),
  });
}
