"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AGENTS, type AgentKey, type AgentStatus } from "@/domain/agents";
import { EventRow } from "./feed";
import { AgentScene } from "./scenes";
import { AgentStreamProvider } from "./stream";
import type { CurrentTask, FeedEvent, SceneData } from "./types";

type Run = { id: string; queue: string; status: string; startedAt: string; completedAt: string | null; dealershipId: string | null; dealershipName: string | null; result: string | null; error: string | null };

const SPEEDS = [1, 4, 12] as const;

/**
 * Replays a finished task from its stored events. Time is scaled, never invented: each event
 * appears at its recorded offset from the task's start, divided by the chosen speed.
 */
export function ReplayPlayer({ agentKey, run, events, data }: { agentKey: AgentKey; run: Run; events: FeedEvent[]; data: SceneData | null }) {
  const reduced = useReducedMotion() ?? false;
  const agent = AGENTS[agentKey];
  const ordered = useMemo(() => [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)), [events]);
  const t0 = Date.parse(run.startedAt);
  const tEnd = Math.max(run.completedAt ? Date.parse(run.completedAt) : t0, ...ordered.map((e) => Date.parse(e.at)));
  const total = Math.max(1000, tEnd - t0);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(4);
  const [pos, setPos] = useState(0); // ms into the task
  const [playing, setPlaying] = useState(true);
  const last = useRef<number | null>(null);

  useEffect(() => {
    if (!playing || reduced) return;
    // Wall-clock deltas on a short interval: keeps advancing in a background tab, where
    // requestAnimationFrame is paused, and never drifts from recorded timings.
    last.current = Date.now();
    const t = setInterval(() => {
      const now = Date.now();
      const dt = (now - (last.current ?? now)) * speed;
      last.current = now;
      setPos((p) => {
        const n = p + dt;
        if (n >= total) {
          setPlaying(false);
          return total;
        }
        return n;
      });
    }, 40);
    return () => {
      clearInterval(t);
      last.current = null;
    };
  }, [playing, speed, total, reduced]);
  // Reduced motion: no auto-play; the finished task is shown and the slider scrubs it by hand.
  const shownPos = reduced && playing ? total : pos;
  const played = ordered.filter((e) => Date.parse(e.at) - t0 <= shownPos);
  const finished = shownPos >= total;
  const status: AgentStatus = finished ? (run.status === "FAILED" ? "ERROR" : "COMPLETED") : "WORKING";
  const current: CurrentTask | null = finished ? null : { jobRunId: run.id, queue: run.queue, dealershipId: run.dealershipId, dealershipName: run.dealershipName, startedAt: run.startedAt, lastStep: played[played.length - 1]?.step ?? null };
  // Scenes compare event times against the wall clock for "recent" effects; shift replayed events so that holds.
  const shift = Date.now() - shownPos - t0;
  const shifted = played.map((e) => ({ ...e, at: new Date(Date.parse(e.at) + shift).toISOString() })).reverse();
  const fmt = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

  return (
    <AgentStreamProvider initialAgents={[{ key: agentKey, status, waiting: 0, queued: 0, current }]} initialEvents={[]} agentKey={agentKey} demo={false} frozen>
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-line bg-surface px-3 py-2 text-[13px]">
        <span className="num rounded-sm px-1.5 text-[10px] uppercase tracking-[0.1em]" style={{ background: agent.color, color: "#06080f" }}>
          Replay
        </span>
        <span>
          {run.queue}
          {run.dealershipName ? <span className="text-muted"> · {run.dealershipName}</span> : null}
        </span>
        <span className="num text-muted">
          {new Date(run.startedAt).toLocaleString("en-US")} · {run.status.toLowerCase()}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className="btn btn-sm" onClick={() => (finished ? (setPos(0), setPlaying(true)) : setPlaying((p) => !p))}>
            {finished ? "Replay again" : playing ? "Pause" : "Play"}
          </button>
          {SPEEDS.map((s) => (
            <button key={s} type="button" className={`btn btn-sm ${speed === s ? "btn-primary" : ""}`} onClick={() => setSpeed(s)}>
              {s}×
            </button>
          ))}
        </div>
        <div className="flex w-full items-center gap-2">
          <span className="num text-[11px] text-muted">{fmt(shownPos)}</span>
          <input type="range" min={0} max={total} value={shownPos} onChange={(e) => (setPlaying(false), setPos(Number(e.target.value)))} className="flex-1 accent-[var(--agent)]" style={{ "--agent": agent.color } as React.CSSProperties} aria-label="Replay position" />
          <span className="num text-[11px] text-muted">{fmt(total)}</span>
          <span className="num text-[11px] text-faint">
            {played.length}/{ordered.length} events
          </span>
        </div>
      </div>
      <AgentScene agentKey={agentKey} status={status} current={current} events={shifted} data={data} reduced={reduced} demo={false} />
      <div className="mt-3 rounded-md border border-line bg-surface">
        <div className="eyebrow border-b border-line px-4 py-2">Events as they happened</div>
        <ul>
          {shifted.length === 0 ? <li className="px-4 py-4 text-[13px] text-muted">Press play.</li> : null}
          {shifted.map((e) => (
            <EventRow key={e.id} e={{ ...e, at: ordered.find((o) => o.id === e.id)?.at ?? e.at }} reduced={reduced} />
          ))}
        </ul>
      </div>
      <p className="mt-2 text-[12px] text-muted">The facts drawn in the scene are the records on file now; the steps and their timing are exactly as recorded for this task.</p>
    </AgentStreamProvider>
  );
}
