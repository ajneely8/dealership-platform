import { AGENT_KEYS, type AgentKey } from "@/domain/agents";
import { getSessionUser } from "@/lib/auth/session";
import { agentEventsFor, agentLive } from "@/lib/agent-state";

export const dynamic = "force-dynamic";

/** Live status + recent activity for one agent; polled by its workspace. */
export async function GET(req: Request, { params }: { params: Promise<{ key: string }> }) {
  if (!(await getSessionUser())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { key } = await params;
  if (!AGENT_KEYS.includes(key as AgentKey)) return Response.json({ error: "Unknown agent" }, { status: 404 });
  const limit = Math.min(200, Math.max(1, Number(new URL(req.url).searchParams.get("limit") ?? 50) || 50));
  const [live, events] = await Promise.all([agentLive(key as AgentKey), agentEventsFor({ agent: key as AgentKey, limit })]);
  return Response.json({
    status: live.status,
    current: live.current ? { ...live.current, startedAt: live.current.startedAt.toISOString() } : null,
    waiting: live.waiting,
    events: events.map((e) => ({ ...e, at: e.at.toISOString() })),
  });
}
