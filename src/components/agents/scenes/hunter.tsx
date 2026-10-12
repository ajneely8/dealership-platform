"use client";

import { AnimatePresence, motion } from "motion/react";
import { AGENTS } from "@/domain/agents";
import type { SceneProps } from "../types";
import { Ambient, Hud, Stage, fade } from "./primitives";

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

/** HUNTER — a radar sweep; each public hiring post or business signal is a blip. */
export function HunterScene({ status, current, events, data, reduced }: SceneProps) {
  const color = AGENTS.hunter.color;
  const working = status === "WORKING";
  const signals = data?.kind === "hunter" ? data.signals.slice(0, 8) : [];
  const justFound = events.find((e) => e.kind === "finding.created" && Date.now() - Date.parse(e.at) < 8000 && /^Growth roles found/.test(e.step));
  const R = 100;

  return (
    <Stage color={color}>
      <Ambient color={color} reduced={reduced} active={working} />
      <div className="relative grid h-full grid-cols-[240px_1fr] gap-3 p-3">
        <div className="relative m-auto" style={{ width: R * 2 + 20, height: R * 2 + 20 }}>
          <svg viewBox={`0 0 ${R * 2 + 20} ${R * 2 + 20}`} className="h-full w-full" aria-hidden>
            {[1, 0.66, 0.33].map((k) => (
              <circle key={k} cx={R + 10} cy={R + 10} r={R * k} fill="none" stroke={color} strokeOpacity="0.35" strokeWidth="1" />
            ))}
            <line x1={10} y1={R + 10} x2={R * 2 + 10} y2={R + 10} stroke={color} strokeOpacity="0.2" />
            <line x1={R + 10} y1={10} x2={R + 10} y2={R * 2 + 10} stroke={color} strokeOpacity="0.2" />
            {signals.map((s, i) => {
              const a = hash(s.id) * Math.PI * 2;
              const r = R * (0.3 + 0.6 * hash(s.title + i));
              const x = R + 10 + Math.cos(a) * r;
              const y = R + 10 + Math.sin(a) * r;
              return (
                <g key={s.id}>
                  <circle cx={x} cy={y} r="3.5" fill={color} />
                  {!reduced ? <circle cx={x} cy={y} r="3.5" fill="none" stroke={color} strokeWidth="1" className="hunter-ping" style={{ animationDelay: `${(i * 0.7) % 3}s` }} /> : null}
                </g>
              );
            })}
          </svg>
          {!reduced && (working || signals.length === 0) ? (
            <motion.div aria-hidden className="absolute inset-[10px] rounded-full" style={{ background: `conic-gradient(from 0deg, ${color}66, ${color}00 70deg, transparent)` }} animate={{ rotate: 360 }} transition={{ duration: working ? 2.4 : 6, repeat: Infinity, ease: "linear" }} />
          ) : null}
          {justFound && !reduced ? <motion.div aria-hidden className="absolute inset-[10px] rounded-full border-2" style={{ borderColor: color }} initial={{ scale: 0.2, opacity: 1 }} animate={{ scale: 1.05, opacity: 0 }} transition={{ duration: 1.4 }} /> : null}
        </div>
        <div className="flex min-w-0 flex-col">
          <div className="mb-1.5 flex items-center justify-between">
            <Hud color={color}>{working ? `Searching · ${current?.dealershipName ?? ""}` : signals.length ? "Signals on file" : "No signals yet"}</Hud>
            <Hud>public sources only</Hud>
          </div>
          <ul className="flex-1 space-y-1 overflow-hidden">
            <AnimatePresence initial={false}>
              {signals.map((s, i) => (
                <motion.li key={s.id} {...fade(reduced, i * 0.04)} className="flex items-center gap-2 rounded-sm border px-2 py-1 text-[12px]" style={{ borderColor: `${color}44`, background: "#0a0d16" }}>
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
                  <span className="truncate">{s.title}</span>
                  <span className="num ml-auto shrink-0 rounded-sm px-1 text-[9.5px] uppercase tracking-[0.08em]" style={{ background: `${color}22`, color }}>
                    {s.type.toLowerCase().replace(/_/g, " ")}
                  </span>
                </motion.li>
              ))}
            </AnimatePresence>
            {signals.length === 0 ? <li className="text-[12px] text-muted">Hiring posts and business signals land here with their source link.</li> : null}
          </ul>
        </div>
      </div>
      <style>{`@keyframes hunter-ping{0%{r:3.5;opacity:.9}100%{r:14;opacity:0}} .hunter-ping{animation:hunter-ping 2.6s ease-out infinite}`}</style>
    </Stage>
  );
}
