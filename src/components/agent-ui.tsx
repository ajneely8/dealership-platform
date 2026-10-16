"use client";

import { useEffect, useState } from "react";
import { AGENT_STATUS_LABEL, type AgentDef, type AgentStatus } from "@/domain/agents";

/**
 * Synthetic faces. Each agent is a faceted visor drawn in code, in its own colour, with its own
 * geometry (helmet width, visor tilt, eye shape, antenna, traces), so the nine read as nine
 * different intelligences rather than one template. SideKick, the orchestrator, wears the logo.
 * While an agent works, its visor pulses; at rest it dims.
 */
const LOGO = "/sidekick-mark.png";

type FaceGeom = { crown: number; jaw: number; visorY: number; tilt: number; eye: "slit" | "wide" | "arc" | "dot"; antenna: boolean; traces: number; chin: boolean };
const GEOM: Record<string, FaceGeom> = {
  nova: { crown: 30, jaw: 22, visorY: 46, tilt: 0, eye: "wide", antenna: true, traces: 3, chin: true },
  charlie: { crown: 28, jaw: 26, visorY: 48, tilt: 4, eye: "slit", antenna: false, traces: 2, chin: true },
  sage: { crown: 32, jaw: 20, visorY: 44, tilt: -3, eye: "arc", antenna: true, traces: 4, chin: false },
  hunter: { crown: 26, jaw: 24, visorY: 50, tilt: 6, eye: "slit", antenna: false, traces: 3, chin: true },
  atlas: { crown: 34, jaw: 28, visorY: 46, tilt: 0, eye: "dot", antenna: false, traces: 4, chin: true },
  blaze: { crown: 28, jaw: 22, visorY: 47, tilt: -5, eye: "slit", antenna: true, traces: 2, chin: false },
  echo: { crown: 30, jaw: 24, visorY: 45, tilt: 0, eye: "arc", antenna: true, traces: 3, chin: true },
  sentinel: { crown: 32, jaw: 26, visorY: 49, tilt: 2, eye: "wide", antenna: false, traces: 4, chin: true },
  orion: { crown: 30, jaw: 24, visorY: 46, tilt: 0, eye: "dot", antenna: false, traces: 0, chin: false },
};

function Eyes({ g, color, cx }: { g: FaceGeom; color: string; cx: number }) {
  const y = g.visorY + 1;
  const t = g.tilt;
  switch (g.eye) {
    case "wide":
      return (
        <>
          <path d={`M${cx - 22} ${y + t} h14`} stroke={color} strokeWidth="3.4" strokeLinecap="round" />
          <path d={`M${cx + 8} ${y - t} h14`} stroke={color} strokeWidth="3.4" strokeLinecap="round" />
        </>
      );
    case "slit":
      return (
        <>
          <path d={`M${cx - 20} ${y + t} l10 -2`} stroke={color} strokeWidth="2.6" strokeLinecap="round" />
          <path d={`M${cx + 10} ${y - t - 2} l10 2`} stroke={color} strokeWidth="2.6" strokeLinecap="round" />
        </>
      );
    case "arc":
      return (
        <>
          <path d={`M${cx - 21} ${y + 2 + t} q7 -7 14 0`} fill="none" stroke={color} strokeWidth="2.6" strokeLinecap="round" />
          <path d={`M${cx + 7} ${y + 2 - t} q7 -7 14 0`} fill="none" stroke={color} strokeWidth="2.6" strokeLinecap="round" />
        </>
      );
    default:
      return (
        <>
          <circle cx={cx - 13} cy={y + t} r="3.2" fill={color} />
          <circle cx={cx + 13} cy={y - t} r="3.2" fill={color} />
        </>
      );
  }
}

/** The face (or the logo) inside a circle, tinted to the agent, pulsing when live and dimmed when idle. */
function Face({ agent, size, idle, live = false }: { agent: AgentDef; size: number; idle: boolean; live?: boolean }) {
  if (agent.key === "orion") {
    return (
      <span className="absolute inset-0 overflow-hidden rounded-full" style={{ background: "#05070c", boxShadow: idle ? "inset 0 0 0 1px rgba(255,255,255,0.08)" : `inset 0 0 0 1px ${agent.color}aa` }} aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element -- a small static asset in the public folder */}
        <img src={LOGO} alt="" className="absolute inset-[16%] h-[68%] w-[68%] object-contain" />
        <span className="absolute inset-0 rounded-full" style={{ background: `radial-gradient(circle at 50% 35%, transparent 55%, ${agent.color}33 100%)` }} />
      </span>
    );
  }
  const g = GEOM[agent.key] ?? GEOM.nova!;
  const c = agent.color;
  const cx = 50;
  const small = size < 40;
  const head = `M${cx - g.crown} 30 Q${cx - g.crown} 14 ${cx} 12 Q${cx + g.crown} 14 ${cx + g.crown} 30 L${cx + g.jaw + 2} 66 Q${cx + g.jaw - 6} 86 ${cx} 88 Q${cx - g.jaw + 6} 86 ${cx - g.jaw - 2} 66 Z`;
  return (
    <span className="absolute inset-0 overflow-hidden rounded-full" style={{ background: `radial-gradient(circle at 50% 30%, ${c}2a, #05070c 72%)` }} aria-hidden>
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full">
        <defs>
          <linearGradient id={`vf-${agent.key}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={c} stopOpacity="0.55" />
            <stop offset="1" stopColor={c} stopOpacity="0.08" />
          </linearGradient>
          <filter id={`vg-${agent.key}`} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {/* traces: data lines behind the head */}
        {!small
          ? Array.from({ length: g.traces }, (_, i) => {
              const y = 22 + i * 16;
              return <path key={i} d={`M4 ${y} h${10 + (i % 2) * 6} l6 6 M96 ${y + 8} h-${12 + (i % 2) * 4} l-6 -6`} fill="none" stroke={c} strokeOpacity="0.35" strokeWidth="1.2" strokeLinecap="round" />;
            })
          : null}
        {/* antenna */}
        {g.antenna ? <path d={`M${cx} 12 v-6`} stroke={c} strokeWidth="2" strokeLinecap="round" /> : null}
        {g.antenna ? <circle cx={cx} cy="5" r="2.2" fill={c} /> : null}
        {/* helmet */}
        <path d={head} fill={`url(#vf-${agent.key})`} stroke={c} strokeOpacity={idle ? 0.55 : 0.95} strokeWidth="2" strokeLinejoin="round" />
        {/* facets */}
        {!small ? <path d={`M${cx - g.crown + 6} 34 L${cx} 24 L${cx + g.crown - 6} 34`} fill="none" stroke={c} strokeOpacity="0.35" strokeWidth="1" /> : null}
        {!small ? <path d={`M${cx - g.jaw + 2} 68 L${cx} 76 L${cx + g.jaw - 2} 68`} fill="none" stroke={c} strokeOpacity="0.3" strokeWidth="1" /> : null}
        {/* visor band */}
        <path d={`M${cx - g.crown + 4} ${g.visorY - 6 + g.tilt} L${cx + g.crown - 4} ${g.visorY - 6 - g.tilt} L${cx + g.crown - 7} ${g.visorY + 8 - g.tilt} L${cx - g.crown + 7} ${g.visorY + 8 + g.tilt} Z`} fill="#05070c" stroke={c} strokeOpacity="0.8" strokeWidth="1.2" />
        <g filter={`url(#vg-${agent.key})`} className={live ? "status-dot-live" : undefined} opacity={idle ? 0.7 : 1}>
          <Eyes g={g} color={c} cx={cx} />
        </g>
        {/* chin core */}
        {g.chin && !small ? <path d={`M${cx - 4} 80 l4 -5 l4 5`} fill="none" stroke={c} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /> : null}
      </svg>
      <span className="absolute inset-0 rounded-full" style={{ boxShadow: idle ? "inset 0 0 0 1px rgba(255,255,255,0.08)" : `inset 0 0 0 1px ${c}aa` }} />
      {idle ? <span className="absolute inset-0 rounded-full bg-[#05070c]/25" /> : null}
    </span>
  );
}

/**
 * Agent marks: the agent's own face inside a segmented ring in its colour.
 * The ring always turns: slowly at rest, quickly while the agent works.
 */
export function AgentAvatar({ agent, size = 56, ring }: { agent: AgentDef; size?: number; ring?: AgentStatus }) {
  const working = ring === "WORKING";
  const idle = !ring || ring === "IDLE";
  const r = 46;
  const c = 2 * Math.PI * r;
  const inner = Math.round(size * 0.72);
  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }} aria-label={`${agent.name} mark`}>
      <svg viewBox="0 0 100 100" className={`absolute inset-0 h-full w-full ${working ? "agent-ring-spin-fast" : "agent-ring-spin"}`} aria-hidden>
        <circle cx="50" cy="50" r={r} fill="none" stroke={agent.color} strokeOpacity={idle ? 0.35 : 0.9} strokeWidth="3" strokeDasharray={`${c * 0.18} ${c * 0.07}`} strokeLinecap="round" />
        <circle cx="50" cy="50" r="38" fill="none" stroke={agent.color} strokeOpacity={idle ? 0.15 : 0.35} strokeWidth="1" strokeDasharray="2 4" />
      </svg>
      <span className="absolute left-1/2 top-1/2 block -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ width: inner, height: inner, boxShadow: idle ? undefined : `0 0 ${Math.round(size / 3)}px ${agent.color}66` }}>
        <Face agent={agent} size={inner} idle={idle} live={working} />
      </span>
      {ring === "ERROR" ? <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-bad" /> : ring === "PAUSED" ? <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-warn" /> : null}
    </span>
  );
}

/** A larger mark for headers and cards: the face and number in a glowing hex frame. */
export function AgentPortrait({ agent, height = 150, className = "" }: { agent: AgentDef; height?: number; glow?: boolean; className?: string }) {
  const width = Math.round(height * 0.88);
  const face = Math.round(height * 0.56);
  return (
    <span className={`relative inline-flex shrink-0 flex-col items-center justify-center ${className}`} style={{ width, height }} aria-label={`${agent.name} mark`}>
      <svg viewBox="0 0 100 114" className="absolute inset-0 h-full w-full" aria-hidden>
        <defs>
          <linearGradient id={`hex-${agent.key}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={agent.color} stopOpacity="0.35" />
            <stop offset="1" stopColor={agent.color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d="M50 3 93 28v58L50 111 7 86V28Z" fill={`url(#hex-${agent.key})`} stroke={agent.color} strokeWidth="1.5" />
        <path d="M50 12 85 32v50L50 102 15 82V32Z" fill="none" stroke={agent.color} strokeOpacity="0.35" strokeWidth="0.8" strokeDasharray="3 3" />
        <path d="M7 28 50 3M93 86 50 111" stroke={agent.color} strokeWidth="3" strokeLinecap="round" />
      </svg>
      <span className="relative block rounded-full" style={{ width: face, height: face, boxShadow: `0 0 22px ${agent.color}66` }}>
        <Face agent={agent} size={face} idle={false} />
      </span>
      <span className="num relative mt-1.5 text-[10px] uppercase tracking-[0.2em]" style={{ color: `${agent.color}cc` }}>
        {agent.number}
      </span>
    </span>
  );
}

export function StatusPill({ status, color }: { status: AgentStatus; color?: string }) {
  const live = status === "WORKING" || status === "WAITING";
  return (
    <span className="num inline-flex items-center gap-1.5 text-[11.5px] uppercase tracking-[0.1em] text-muted">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${live ? "status-dot-live" : ""}`} style={{ background: status === "ERROR" ? "var(--color-bad)" : status === "PAUSED" ? "var(--color-warn)" : status === "IDLE" ? "var(--color-faint)" : (color ?? "var(--color-good)") }} />
      {AGENT_STATUS_LABEL[status]}
    </span>
  );
}

/** Seconds since an instant, ticking. Built from the stored timestamp, never a counter of its own. */
export function Elapsed({ since, className = "" }: { since: string | Date; className?: string }) {
  const start = typeof since === "string" ? new Date(since).getTime() : since.getTime();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - start) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const text = h > 0 ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return <span className={`num ${className}`}>{text}</span>;
}

/** Copy-to-clipboard for brief text. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          // clipboard unavailable (insecure context); nothing else to do
        }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}
