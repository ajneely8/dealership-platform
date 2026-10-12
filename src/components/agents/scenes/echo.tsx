"use client";

import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { AGENTS } from "@/domain/agents";
import { Elapsed } from "../../agent-ui";
import type { SceneProps } from "../types";
import { Ambient, Hud, Stage, fmtSeconds } from "./primitives";

const CHANNELS = [
  { key: "EMAIL", label: "Email", test: /^Email received/ },
  { key: "SMS", label: "SMS", test: /^Text message received/ },
  { key: "PHONE", label: "Call", test: /^Phone call received/ },
  { key: "CHAT", label: "Chat", test: /^Reply received|^Reply:/ },
] as const;

const WINDOW_H = 24;

function Ring({ since, color, reduced }: { since: string; color: string; reduced: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const frac = Math.min(1, (now - Date.parse(since)) / (WINDOW_H * 3600_000));
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 64 64" className="h-16 w-16" aria-hidden>
      <circle cx="32" cy="32" r={r} fill="none" stroke="#1b2333" strokeWidth="4" />
      <motion.circle cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeDasharray={c} animate={{ strokeDashoffset: c * (1 - frac) }} transition={{ duration: reduced ? 0 : 0.8 }} transform="rotate(-90 32 32)" />
      {!reduced ? <motion.line x1="32" y1="32" x2="32" y2="12" stroke={color} strokeWidth="1.5" strokeLinecap="round" animate={{ rotate: 360 }} transition={{ duration: 60, repeat: Infinity, ease: "linear" }} style={{ originX: "32px", originY: "32px" }} /> : null}
    </svg>
  );
}

/** ECHO — one clock per open test, and the channels a reply can arrive on. */
export function EchoScene({ status, events, data, reduced }: SceneProps) {
  const color = AGENTS.echo.color;
  const d = data?.kind === "echo" ? data : null;
  const open = d?.open.slice(0, 3) ?? [];
  const now = Date.now();
  const lit = (test: RegExp) => events.some((e) => e.kind === "response.received" && test.test(e.step) && now - Date.parse(e.at) < 10_000);

  return (
    <Stage color={color}>
      <Ambient color={color} reduced={reduced} active={status === "WORKING" || status === "WAITING"} />
      <div className="relative grid h-full grid-cols-[1fr_170px] gap-3 p-3">
        <div className="flex flex-col">
          <Hud color={color} className="mb-2">
            {open.length ? `${open.length} open test${open.length === 1 ? "" : "s"} · waiting for the dealership` : "No open tests"}
          </Hud>
          <div className="grid flex-1 grid-cols-3 gap-2">
            {open.map((t) => (
              <div key={t.id} className="flex flex-col items-center justify-center rounded-sm border p-2 text-center" style={{ borderColor: `${color}55`, background: "#0a0d16" }}>
                <Ring since={t.submittedAt} color={t.firstResponseSeconds !== null ? "var(--color-good)" : color} reduced={reduced} />
                <div className="num mt-1 text-[15px]" style={{ color }}>
                  {t.firstResponseSeconds !== null ? fmtSeconds(t.firstResponseSeconds) : <Elapsed since={t.submittedAt} />}
                </div>
                <div className="truncate text-[11px] text-muted" style={{ maxWidth: 120 }}>
                  {t.dealershipName}
                </div>
                <div className="num text-[9.5px] uppercase tracking-[0.1em] text-faint">{t.testType} · {t.firstResponseSeconds !== null ? "replied" : "no reply yet"}</div>
              </div>
            ))}
            {open.length === 0 ? <p className="col-span-3 m-auto text-[12px] text-muted">Clocks start when Charlie submits an inquiry and stop at the first reply.</p> : null}
          </div>
        </div>
        <div className="flex flex-col justify-center gap-2">
          {CHANNELS.map((c) => {
            const on = lit(c.test);
            const n = d?.channels[c.key] ?? 0;
            return (
              <motion.div key={c.key} className="flex items-center justify-between rounded-sm border px-2 py-1.5 text-[12px]" style={{ borderColor: on ? color : `${color}33`, background: on ? `${color}22` : "#0a0d16" }} animate={on && !reduced ? { scale: [1, 1.04, 1] } : { scale: 1 }} transition={{ duration: 0.6 }}>
                <span className="flex items-center gap-2">
                  <span className={`inline-block h-2 w-2 rounded-full ${on && !reduced ? "status-dot-live" : ""}`} style={{ background: on ? color : "#2a3348" }} />
                  {c.label}
                </span>
                <span className="num text-[11px] text-muted">{n} / 7d</span>
              </motion.div>
            );
          })}
          <Hud className="text-center">inbound via webhooks or manual log</Hud>
        </div>
      </div>
    </Stage>
  );
}
