"use client";

import { AnimatePresence, motion } from "motion/react";
import { AGENTS, AGENT_KEYS, type AgentKey, type AgentStatus } from "@/domain/agents";
import { useAgentStream } from "../stream";
import type { FeedEvent, SceneProps } from "../types";
import { Ambient, Hud, Stage } from "./primitives";

const RING: AgentKey[] = AGENT_KEYS.filter((k) => k !== "orion");
const DISPATCH_WINDOW_MS = 4000;

/** A pulse travelling from the hub to an agent for every real task.created / task.started event. */
function dispatches(events: FeedEvent[], now: number) {
  return events.filter((e) => (e.kind === "task.created" || e.kind === "task.started") && now - Date.parse(e.at) < DISPATCH_WINDOW_MS);
}

const STATUS_FILL: Record<AgentStatus, string> = { WORKING: "", WAITING: "", SCHEDULED: "", COMPLETED: "", ERROR: "var(--color-bad)", PAUSED: "var(--color-warn)", IDLE: "#1b2333" };

/** ORION — the hub. Lines to every agent; pulses on the line when a job is handed over. */
export function OrionScene({ status, events, data, reduced, wide = false }: SceneProps & { wide?: boolean }) {
  const color = AGENTS.orion.color;
  const { agents } = useAgentStream();
  const d = data?.kind === "orion" ? data : null;
  const now = Date.now();
  const pulses = dispatches(events, now);
  const W = wide ? 760 : 420;
  const H = wide ? 300 : 236;
  const cx = W / 2;
  const cy = H / 2;
  const rx = wide ? 300 : 160;
  const ry = wide ? 110 : 88;
  const pos = (i: number) => {
    const a = -Math.PI / 2 + (i / RING.length) * Math.PI * 2;
    return { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry };
  };
  const busy = agents.filter((a) => a.status === "WORKING").length;

  return (
    <Stage color={color} height={wide ? 320 : 260}>
      <Ambient color={color} reduced={reduced} active={status === "WORKING" || busy > 0} />
      <div className="absolute left-3 top-2 flex items-center gap-3">
        <Hud color={color}>{d?.window.open ? "Research hours open" : "Outside research hours"}</Hud>
        <Hud>
          {busy} working · {d ? d.queues.reduce((a, q) => a + q.waiting, 0) : 0} queued · {d ? d.queues.reduce((a, q) => a + q.delayed, 0) : 0} parked
        </Hud>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full" aria-hidden>
        <defs>
          <radialGradient id="orion-hub">
            <stop offset="0" stopColor={color} stopOpacity="0.9" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </radialGradient>
        </defs>
        {RING.map((k, i) => {
          const p = pos(i);
          const a = AGENTS[k];
          const live = agents.find((x) => x.key === k);
          const working = live?.status === "WORKING";
          return (
            <g key={k}>
              <line x1={cx} y1={cy} x2={p.x} y2={p.y} stroke={working ? a.color : color} strokeOpacity={working ? 0.9 : 0.25} strokeWidth={working ? 1.5 : 1} />
              {working && !reduced ? <motion.circle r="2.5" fill={a.color} initial={{ cx: p.x, cy: p.y }} animate={{ cx: [p.x, cx], cy: [p.y, cy] }} transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }} /> : null}
            </g>
          );
        })}
        {/* dispatch pulses: hub → agent, one per real event */}
        <AnimatePresence>
          {pulses.map((e) => {
            const i = RING.indexOf(e.agent as AgentKey);
            if (i < 0) return null;
            const p = pos(i);
            return reduced ? null : <motion.circle key={e.id} r="4" fill={AGENTS[e.agent as AgentKey].color} initial={{ cx: cx, cy: cy, opacity: 1 }} animate={{ cx: p.x, cy: p.y, opacity: [1, 1, 0] }} exit={{ opacity: 0 }} transition={{ duration: 1.2, ease: "easeOut" }} />;
          })}
        </AnimatePresence>
        {/* hub */}
        <motion.g style={{ transformBox: "fill-box", transformOrigin: "center" }} animate={reduced ? undefined : { scale: [0.92, 1.08, 0.92] }} transition={{ duration: 3.5, repeat: Infinity, ease: "easeInOut" }}>
          <circle cx={cx} cy={cy} r={wide ? 54 : 44} fill="url(#orion-hub)" />
        </motion.g>
        <circle cx={cx} cy={cy} r={wide ? 22 : 18} fill="#0a0d16" stroke={color} strokeWidth="1.5" />
        <text x={cx} y={cy + 4} textAnchor="middle" fontFamily="var(--font-mono)" fontSize="10" letterSpacing="2" fill={color}>
          ORION
        </text>
        {/* agent nodes */}
        {RING.map((k, i) => {
          const p = pos(i);
          const a = AGENTS[k];
          const live = agents.find((x) => x.key === k);
          const st = live?.status ?? "IDLE";
          const fill = st === "IDLE" ? STATUS_FILL.IDLE : st === "ERROR" ? STATUS_FILL.ERROR : st === "PAUSED" ? STATUS_FILL.PAUSED : a.color;
          return (
            <g key={k}>
              {st === "WORKING" && !reduced ? (
                <motion.g style={{ transformBox: "fill-box", transformOrigin: "center" }} animate={{ scale: [1, 1.7], opacity: [0.8, 0] }} transition={{ duration: 1.4, repeat: Infinity }}>
                  <circle cx={p.x} cy={p.y} r="12" fill="none" stroke={a.color} strokeWidth="1" />
                </motion.g>
              ) : null}
              <circle cx={p.x} cy={p.y} r="11" fill="#0a0d16" stroke={fill} strokeWidth="2" />
              <text x={p.x} y={p.y + 3.5} textAnchor="middle" fontFamily="var(--font-mono)" fontSize="9" fill={st === "IDLE" ? "var(--color-muted)" : a.color}>
                {a.number}
              </text>
              <text x={p.x} y={p.y + (i === 0 ? -16 : i === 4 ? 24 : 22)} textAnchor="middle" fontFamily="var(--font-mono)" fontSize="8.5" letterSpacing="1.5" fill={st === "IDLE" ? "var(--color-faint)" : a.color}>
                {a.name.toUpperCase()}
              </text>
            </g>
          );
        })}
      </svg>
    </Stage>
  );
}
