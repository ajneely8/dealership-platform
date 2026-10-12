"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AgentKey } from "@/domain/agents";
import { runDemo } from "./demo";
import type { AgentSnapshot, FeedEvent } from "./types";

type Transport = "stream" | "polling" | "demo" | "connecting";

export type StreamState = {
  agents: AgentSnapshot[];
  events: FeedEvent[];
  transport: Transport;
  demo: boolean;
  /** Monotonic counter bumped on every new event; cheap dependency for effects. */
  tick: number;
};

const Ctx = createContext<StreamState | null>(null);

const MAX_EVENTS = 150;

function mergeEvents(prev: FeedEvent[], incoming: FeedEvent[]): FeedEvent[] {
  if (incoming.length === 0) return prev;
  const ids = new Set(prev.map((e) => e.id));
  const fresh = incoming.filter((e) => !ids.has(e.id));
  if (fresh.length === 0) return prev;
  return [...fresh, ...prev].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, MAX_EVENTS);
}

/**
 * Feeds every live component on a page from one connection.
 *
 * Live: an authenticated SSE stream at /api/events/stream, falling back to polling the same
 * JSON the pages render from. Demo: a scripted client-side generator that never touches the
 * backend — every event it produces is flagged and labelled.
 */
export function AgentStreamProvider({ children, initialAgents, initialEvents, agentKey, dealershipId, demo = false, frozen = false }: { children: React.ReactNode; initialAgents: AgentSnapshot[]; initialEvents: FeedEvent[]; agentKey?: AgentKey; dealershipId?: string; demo?: boolean; /** Replay: no connection; the props are the state. */ frozen?: boolean }) {
  const router = useRouter();
  // Demo mode starts from a blank slate so nothing real is mistaken for a simulated event.
  const [agents, setAgents] = useState<AgentSnapshot[]>(() => (demo ? initialAgents.map((a) => ({ ...a, status: "IDLE" as const, current: null, waiting: 0, queued: 0 })) : initialAgents));
  const [events, setEvents] = useState<FeedEvent[]>(() => (demo ? [] : initialEvents));
  const [transport, setTransport] = useState<Transport>(demo ? "demo" : "connecting");
  const [tick, setTick] = useState(0);
  const workingRef = useRef(new Set(initialAgents.filter((a) => a.status === "WORKING").map((a) => a.key)));

  // Refresh server-rendered findings when an agent finishes a task.
  const applyState = (next: AgentSnapshot[]) => {
    const nowWorking = new Set(next.filter((a) => a.status === "WORKING").map((a) => a.key));
    let finished = false;
    for (const k of workingRef.current) if (!nowWorking.has(k)) finished = true;
    workingRef.current = nowWorking;
    setAgents(next);
    if (finished && !demo) router.refresh();
  };

  useEffect(() => {
    if (frozen) return;
    if (demo) {
      return runDemo({
        onState: (next) => setAgents(next),
        onEvent: (e) => {
          setEvents((prev) => mergeEvents(prev, [e]));
          setTick((t) => t + 1);
        },
        focus: agentKey,
      });
    }
    let stopped = false;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let lastAt = initialEvents[0]?.at ?? new Date(Date.now() - 60_000).toISOString();

    const poll = async () => {
      if (stopped) return;
      try {
        const res = await fetch(agentKey ? `/api/agents/${agentKey}?limit=60` : `/api/activity?limit=60`, { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as { agents?: AgentSnapshot[]; events: FeedEvent[]; status?: string; current?: AgentSnapshot["current"] };
          if (data.agents) applyState(data.agents);
          else if (agentKey && data.status) applyState([{ key: agentKey, status: data.status as AgentSnapshot["status"], waiting: 0, queued: 0, current: data.current ?? null }]);
          setEvents((prev) => mergeEvents(prev, data.events));
          setTick((t) => t + 1);
        }
      } catch {
        // next tick
      }
      if (!stopped) pollTimer = setTimeout(poll, workingRef.current.size ? 3000 : 10000);
    };

    const openStream = () => {
      if (stopped || typeof EventSource === "undefined") {
        setTransport("polling");
        void poll();
        return;
      }
      const q = new URLSearchParams();
      if (agentKey) q.set("agent", agentKey);
      if (dealershipId) q.set("dealership", dealershipId);
      q.set("after", lastAt);
      es = new EventSource(`/api/events/stream?${q.toString()}`);
      es.addEventListener("open", () => setTransport("stream"));
      es.addEventListener("state", (m) => {
        const data = JSON.parse((m as MessageEvent).data) as { agents: AgentSnapshot[] };
        applyState(data.agents);
      });
      es.addEventListener("event", (m) => {
        const e = JSON.parse((m as MessageEvent).data) as FeedEvent;
        if (e.at > lastAt) lastAt = e.at;
        setEvents((prev) => mergeEvents(prev, [e]));
        setTick((t) => t + 1);
      });
      es.addEventListener("error", () => {
        // The browser retries SSE on its own; if it cannot connect at all, poll instead.
        if (es && es.readyState === EventSource.CLOSED) {
          es.close();
          es = null;
          setTransport("polling");
          void poll();
        }
      });
    };
    openStream();
    return () => {
      stopped = true;
      es?.close();
      if (pollTimer) clearTimeout(pollTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- connection is keyed by scope only
  }, [agentKey, dealershipId, demo, frozen]);

  const value = useMemo<StreamState>(() => (frozen ? { agents: initialAgents, events: initialEvents, transport: "polling", demo: false, tick: 0 } : { agents, events, transport, demo, tick }), [frozen, initialAgents, initialEvents, agents, events, transport, demo, tick]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAgentStream(): StreamState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAgentStream must be used inside AgentStreamProvider");
  return v;
}

export function useAgent(key: AgentKey): AgentSnapshot {
  const { agents } = useAgentStream();
  return agents.find((a) => a.key === key) ?? { key, status: "IDLE", waiting: 0, queued: 0, current: null };
}

export function useAgentEvents(key?: AgentKey): FeedEvent[] {
  const { events } = useAgentStream();
  return useMemo(() => (key ? events.filter((e) => e.agent === key) : events), [events, key]);
}
