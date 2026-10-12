"use client";

import Link from "next/link";
import { useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { AGENTS, type AgentKey } from "@/domain/agents";
import { AgentPortrait, Elapsed, StatusPill } from "../agent-ui";
import { demoSceneData } from "./demo";
import { AgentFeed, CurrentTaskBar } from "./feed";
import { AgentScene } from "./scenes";
import { STATUS_COPY } from "./scenes/primitives";
import { useAgent, useAgentEvents, useAgentStream } from "./stream";
import type { FeedEvent, SceneData } from "./types";

/** Header block of a workspace: avatar, name, live status, current task. */
export function WorkspaceHeader({ agentKey, children }: { agentKey: AgentKey; children?: React.ReactNode }) {
  const agent = AGENTS[agentKey];
  const live = useAgent(agentKey);
  return (
    <header className="mb-4 flex flex-wrap items-center gap-5 border-b border-line pb-4">
      <AgentPortrait agent={agent} height={150} />
      <div className="min-w-0 flex-1">
        <div className="num text-[11px] uppercase tracking-[0.14em]" style={{ color: agent.color }}>
          Agent {agent.number} · {agent.role}
        </div>
        <h1 className="glow-text text-[30px] font-semibold leading-tight" style={{ color: agent.color }}>{agent.name}</h1>
        <p className="mt-1 max-w-[560px] text-[13.5px] leading-snug text-muted">{agent.purpose}</p>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[14px] text-muted">
          <StatusPill status={live.status} color={agent.color} />
          {live.current ? (
            <span>
              {live.current.lastStep ?? `Running ${live.current.queue}`}
              {live.current.dealershipName ? <> on {live.current.dealershipName}</> : null} · <Elapsed since={live.current.startedAt} />
            </span>
          ) : (
            <span>{STATUS_COPY[live.status]}</span>
          )}
        </div>
      </div>
      {children}
    </header>
  );
}

/** The animated stage plus the live task panel, fed by the stream (or demo). */
export function WorkspaceStage({ agentKey, data }: { agentKey: AgentKey; data: SceneData | null }) {
  const reduced = useReducedMotion() ?? false;
  const live = useAgent(agentKey);
  const events = useAgentEvents(agentKey);
  const { demo, tick } = useAgentStream();
  // Scenes read "recent" events against the clock; re-render once a second while anything is live.
  const [, bump] = useState(0);
  useEffect(() => {
    if (live.status !== "WORKING" && live.status !== "WAITING" && !demo) return;
    const t = setInterval(() => bump((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live.status, demo]);
  const sceneData = useMemo(() => (demo ? demoSceneData(agentKey) : data), [demo, agentKey, data]);
  const jobEvents = live.current ? events.filter((e) => e.jobRunId === live.current!.jobRunId) : [];
  void tick;
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_300px]">
      <AgentScene agentKey={agentKey} status={live.status} current={live.current} events={events} data={sceneData} reduced={reduced} demo={demo} />
      <TaskPanel agentKey={agentKey} jobEvents={jobEvents} />
    </div>
  );
}

function TaskPanel({ agentKey, jobEvents }: { agentKey: AgentKey; jobEvents: FeedEvent[] }) {
  const live = useAgent(agentKey);
  const agent = AGENTS[agentKey];
  const steps = [...jobEvents].reverse().slice(-8);
  return (
    <div className="flex flex-col rounded-md border border-line bg-surface">
      <div className="border-b border-line px-3 py-2">
        <div className="eyebrow">Current task</div>
        {live.current ? (
          <div className="mt-0.5 text-[14px]">
            <span className="num" style={{ color: agent.color }}>
              {live.current.queue}
            </span>
            {live.current.dealershipName ? <span className="text-muted"> · {live.current.dealershipName}</span> : null}
            <span className="num float-right text-muted">
              <Elapsed since={live.current.startedAt} />
            </span>
          </div>
        ) : (
          <div className="mt-0.5 text-[13px] text-muted">{live.status === "WAITING" ? `Waiting on ${live.waiting} open item${live.waiting === 1 ? "" : "s"}` : live.queued ? `${live.queued} job${live.queued === 1 ? "" : "s"} scheduled` : "Nothing running"}</div>
        )}
      </div>
      <ol className="flex-1 space-y-1.5 px-3 py-2 text-[13.5px] leading-snug">
        {steps.length === 0 ? <li className="text-muted">{live.current ? "First step coming up…" : "Steps of the running task appear here."}</li> : null}
        {steps.map((e, i) => (
          <li key={e.id} className="flex items-start gap-2">
            <span className="num mt-0.5 w-4 shrink-0 text-right text-[10px] text-faint">{i + 1}</span>
            <span className={`mt-[6px] inline-block h-1.5 w-1.5 shrink-0 rounded-full ${i === steps.length - 1 && live.current ? "status-dot-live" : ""}`} style={{ background: e.status === "ERROR" ? "var(--color-bad)" : e.status === "BLOCKED" ? "var(--color-warn)" : agent.color }} />
            <span className="min-w-0 break-words">{e.step}</span>
          </li>
        ))}
      </ol>
      {live.current && !live.current.jobRunId.startsWith("demo") ? (
        <div className="border-t border-line px-3 py-1.5 text-[11.5px]">
          <Link href={`/agents/${agentKey}?tab=activity`} className="text-blue-light hover:underline">
            Full live activity
          </Link>
        </div>
      ) : null}
    </div>
  );
}

export { AgentFeed, CurrentTaskBar };
