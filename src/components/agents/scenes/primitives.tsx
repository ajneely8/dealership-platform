"use client";

import { motion } from "motion/react";
import type { AgentStatus } from "@/domain/agents";

/** Shared pieces for the nine scenes: a stage frame, HUD labels, ambient motion and status copy. */

export const STATUS_COPY: Record<AgentStatus, string> = {
  WORKING: "Working",
  IDLE: "Standing by",
  WAITING: "Waiting",
  SCHEDULED: "Scheduled",
  COMPLETED: "Task complete",
  ERROR: "Last task failed",
  PAUSED: "Paused",
};

export function Stage({ color, children, className = "", height = 260 }: { color: string; children: React.ReactNode; className?: string; height?: number }) {
  return (
    <div className={`relative overflow-hidden rounded-md border border-line bg-[#070b14] ${className}`} style={{ height, "--agent": color } as React.CSSProperties}>
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.07]" style={{ backgroundImage: "linear-gradient(var(--agent) 1px, transparent 1px), linear-gradient(90deg, var(--agent) 1px, transparent 1px)", backgroundSize: "28px 28px" }} />
      <div aria-hidden className="pointer-events-none absolute -left-20 -top-20 h-64 w-64 rounded-full opacity-20 blur-3xl" style={{ background: color }} />
      {children}
    </div>
  );
}

export function Hud({ children, className = "", color }: { children: React.ReactNode; className?: string; color?: string }) {
  return (
    <div className={`num text-[10px] uppercase tracking-[0.14em] ${className}`} style={{ color: color ?? "var(--color-muted)" }}>
      {children}
    </div>
  );
}

/** Slow breathing glow used while an agent is idle. Static under reduced motion. */
export function Ambient({ color, reduced, active }: { color: string; reduced: boolean; active: boolean }) {
  return (
    <motion.div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0 h-24"
      style={{ background: `linear-gradient(to top, ${color}22, transparent)` }}
      animate={reduced ? { opacity: active ? 0.9 : 0.5 } : active ? { opacity: [0.7, 1, 0.7] } : { opacity: [0.35, 0.6, 0.35] }}
      transition={reduced ? { duration: 0 } : { duration: active ? 1.6 : 4.5, repeat: Infinity, ease: "easeInOut" }}
    />
  );
}

/** A horizontal scanning beam while working. */
export function Beam({ color, reduced, on }: { color: string; reduced: boolean; on: boolean }) {
  if (!on || reduced) return null;
  return <motion.div aria-hidden className="pointer-events-none absolute inset-x-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${color}, transparent)`, boxShadow: `0 0 12px ${color}` }} initial={{ top: "8%" }} animate={{ top: ["8%", "92%", "8%"] }} transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }} />;
}

export function Tick({ state, color }: { state: "done" | "active" | "todo" | "blocked"; color: string }) {
  const bg = state === "done" ? color : state === "blocked" ? "var(--color-warn)" : "transparent";
  return (
    <span className="relative inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border" style={{ borderColor: state === "todo" ? "var(--color-line)" : state === "blocked" ? "var(--color-warn)" : color, background: bg }}>
      {state === "done" ? (
        <svg viewBox="0 0 10 10" className="h-2 w-2" aria-hidden>
          <path d="M2 5.2 4.2 7.4 8 3" fill="none" stroke="#06080f" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : state === "active" ? (
        <motion.span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} animate={{ scale: [1, 1.5, 1], opacity: [1, 0.5, 1] }} transition={{ duration: 1.1, repeat: Infinity }} />
      ) : null}
    </span>
  );
}

export const fade = (reduced: boolean, delay = 0) => ({
  initial: reduced ? false : { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: reduced ? undefined : { opacity: 0, y: -6 },
  transition: { duration: reduced ? 0 : 0.35, delay: reduced ? 0 : delay, ease: "easeOut" as const },
});

export function shortTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function fmtSeconds(s: number) {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
