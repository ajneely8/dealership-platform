import { AGENT_KEYS, type AgentKey } from "@/domain/agents";
import { getSessionUser } from "@/lib/auth/session";
import { agentEventsFor, allAgentsLive } from "@/lib/agent-state";

export const dynamic = "force-dynamic";

/**
 * Authenticated live stream (Server-Sent Events) of agent state and events.
 *
 * Supabase Realtime is not part of this deployment, so this route plays that role: it tails the
 * agent_events table and the derived agent statuses and pushes them to the browser over one
 * long-lived HTTP response. The browser falls back to polling if the stream cannot be opened.
 *
 *   event: state   — every agent's status and current task (every 4 s, or sooner after an event)
 *   event: event   — one agent_events row, in the order it was written
 *   : ping         — heartbeat every 15 s
 */
export async function GET(req: Request) {
  if (!(await getSessionUser())) return new Response("Unauthorized", { status: 401 });
  const url = new URL(req.url);
  const agentParam = url.searchParams.get("agent");
  const agent = agentParam && AGENT_KEYS.includes(agentParam as AgentKey) ? (agentParam as AgentKey) : undefined;
  const dealershipId = url.searchParams.get("dealership") ?? undefined;
  const afterParam = url.searchParams.get("after");
  let cursor = afterParam && !Number.isNaN(Date.parse(afterParam)) ? new Date(afterParam) : new Date();
  const seen = new Set<string>();

  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (type: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const tick = async () => {
        if (closed) return;
        try {
          const rows = await agentEventsFor({ agent, dealershipId, after: new Date(cursor.getTime() - 2000), limit: 100 });
          const fresh = rows.filter((r) => !seen.has(r.id)).sort((a, b) => a.at.getTime() - b.at.getTime());
          for (const r of fresh) {
            seen.add(r.id);
            if (r.at > cursor) cursor = r.at;
            send("event", { ...r, at: r.at.toISOString() });
          }
          if (seen.size > 2000) {
            // keep the de-duplication window bounded; anything this old is well past the cursor
            const keep = [...seen].slice(-500);
            seen.clear();
            for (const k of keep) seen.add(k);
          }
        } catch (err) {
          send("warning", { message: (err as Error).message });
        }
      };
      const state = async () => {
        if (closed) return;
        try {
          const agents = await allAgentsLive();
          send("state", {
            at: new Date().toISOString(),
            agents: agents.map((a) => ({ key: a.key, status: a.status, waiting: a.waiting, queued: a.queued + a.parked, current: a.current ? { ...a.current, startedAt: a.current.startedAt.toISOString() } : null })),
          });
        } catch (err) {
          send("warning", { message: (err as Error).message });
        }
      };
      void state();
      void tick();
      const t1 = setInterval(() => void tick(), 1500);
      const t2 = setInterval(() => void state(), 4000);
      const t3 = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
        } catch {
          closed = true;
        }
      }, 15000);
      const stop = () => {
        closed = true;
        clearInterval(t1);
        clearInterval(t2);
        clearInterval(t3);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      req.signal.addEventListener("abort", stop);
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
  });
}
