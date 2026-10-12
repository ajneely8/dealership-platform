"use client";

import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AGENTS, AGENT_KEYS, agentForQueue, type AgentKey } from "@/domain/agents";
import { QUEUES, type QueueName } from "@/domain/constants";
import { AgentAvatar } from "../agent-ui";
import { useAgentStream } from "./stream";
import type { FeedEvent } from "./types";

/**
 * The workforce network: Orion in command at the top, the eight working agents on the floor
 * below in relay order. Every moving signal here is a stored event:
 *
 *   Orion → agent      task.created / task.scheduled (a job handed out or parked)
 *   agent → next agent task.completed (scan → Atlas, scores → Blaze, inquiry → Echo, reply → Atlas)
 *   agent → agent      task.created "Hand-off to …" (the relay baton)
 *   Orion → Charlie    task.created (approved) / task.blocked (refused)
 *   agent → Orion      task.failed
 *   burst at a node    task.started / finding.created / evidence.saved / response.received
 *
 * A pass is drawn as a packet: the conduit between the two agents charges, a light with a tail
 * travels it, the receiver ripples on arrival, and the message lands beside the receiver.
 * Nothing drifts on its own; the slow drift in the conduits and Orion's rings is a frame.
 */

type Msg = { id: string; from: AgentKey; to: AgentKey; label: string; at: number; tone: "ok" | "bad" | "info" };
type Burst = { id: string; agent: AgentKey; at: number; kind: string };

const MESSAGE_MS = 4200;
/** A relay hand-off is the signal people watch for; it stays on the stage much longer than a routine message. */
const HANDOFF_MS = 20_000;
const BURST_MS = 1400;
const BUBBLE_MS = 9000;
/** How long the packet takes to travel the conduit. */
const TRAVEL_S = 1.1;
const NEXT: Partial<Record<QueueName, AgentKey>> = { discovery: "nova", "website-scan": "atlas", inventory: "atlas", estimate: "atlas", signals: "atlas", social: "atlas", scoring: "blaze", interaction: "echo", "response-check": "atlas" };
const QUEUE_SET = new Set<string>(QUEUES);

function signalsFrom(events: FeedEvent[], now: number): { msgs: Msg[]; bursts: Burst[] } {
  const msgs: Msg[] = [];
  const bursts: Burst[] = [];
  for (const e of events) {
    const at = Date.parse(e.at);
    const isHandOff = e.kind === "task.created" && e.step.startsWith("Hand-off to ");
    if (now - at > (isHandOff ? HANDOFF_MS : MESSAGE_MS) || now < at) continue;
    const agent = e.agent as AgentKey;
    const queue = e.step.split(" ")[0] ?? "";
    const q = QUEUE_SET.has(queue) ? (queue as QueueName) : null;
    switch (e.kind) {
      case "task.created": {
        const hand = /^Hand-off to (\w+) — (.+)$/.exec(e.step);
        const to = hand ? AGENT_KEYS.find((k) => AGENTS[k].name === hand[1]) : undefined;
        if (hand && to && to !== agent) {
          msgs.push({ id: e.id, from: agent, to, label: hand[2]!, at, tone: "ok" });
          break;
        }
        if (agent === "orion" && q) msgs.push({ id: e.id, from: "orion", to: agentForQueue(q), label: `run ${q}`, at, tone: "info" });
        else if (agent === "orion" && /approved/.test(e.step)) msgs.push({ id: e.id, from: "orion", to: "charlie", label: "test approved", at, tone: "ok" });
        else if (agent === "orion") msgs.push({ id: e.id, from: "orion", to: "nova", label: e.step.replace(/^Scheduled /, "queued "), at, tone: "info" });
        break;
      }
      case "task.scheduled": {
        const parked = /^Parked (\S+)/.exec(e.step)?.[1];
        msgs.push({ id: e.id, from: "orion", to: parked && QUEUE_SET.has(parked) ? agentForQueue(parked as QueueName) : "nova", label: parked ? `${parked} parked until research hours` : "holding research", at, tone: "info" });
        break;
      }
      case "task.completed": {
        const to = q ? NEXT[q] : undefined;
        if (q && to && to !== agent) msgs.push({ id: e.id, from: agent, to, label: q === "interaction" ? "inquiry sent · start the clock" : q === "scoring" ? "scores ready" : q === "response-check" ? "reply logged" : `${q} results`, at, tone: "ok" });
        break;
      }
      case "task.failed":
        msgs.push({ id: e.id, from: agent, to: "orion", label: `${queue} failed`, at, tone: "bad" });
        break;
      case "task.blocked":
        if (agent === "orion" && /refused|not requested/.test(e.step)) msgs.push({ id: e.id, from: "orion", to: "charlie", label: "refused", at, tone: "bad" });
        else bursts.push({ id: e.id, agent, at, kind: e.kind });
        break;
      case "response.received":
        if (agent === "echo") msgs.push({ id: e.id, from: "echo", to: "atlas", label: "dealership replied", at, tone: "ok" });
        else bursts.push({ id: e.id, agent, at, kind: e.kind });
        break;
      case "task.started":
      case "finding.created":
      case "evidence.saved":
        if (now - at <= BURST_MS) bursts.push({ id: e.id, agent, at, kind: e.kind });
        break;
      default:
        break;
    }
  }
  return { msgs, bursts };
}

/** The floor, left to right: the relay order, then Echo who listens for replies. */
const FLOOR: AgentKey[] = ["nova", "sentinel", "charlie", "sage", "hunter", "atlas", "blaze", "echo"];
/** Conduits between agents that pass work to each other directly. */
const LINKS: [AgentKey, AgentKey][] = [
  ["nova", "sentinel"],
  ["sentinel", "charlie"],
  ["charlie", "sage"],
  ["sage", "hunter"],
  ["hunter", "atlas"],
  ["atlas", "blaze"],
  ["charlie", "echo"],
  ["echo", "atlas"],
];

/** Estimated size of a bubble from its text, so bubbles can be laid out before they render. */
function bubbleSize(text: string) {
  const width = Math.min(320, Math.max(140, 20 + text.length * 7.2));
  const lines = Math.ceil((text.length * 7.2) / (width - 24));
  return { w: width, h: 26 + lines * 19 };
}

type Baton = { holder: AgentKey; dealership: string; note: string; at: number };

/** The relay baton, from the newest relay event in the stream (events arrive newest first). */
function batonFrom(events: FeedEvent[]): Baton | null {
  for (const e of events) {
    if (/^(Relay finished|Released the relay)/.test(e.step)) return null;
    const hand = /^Hand-off to (\w+) — (.+)$/.exec(e.step);
    if (hand) {
      const holder = AGENT_KEYS.find((k) => AGENTS[k].name === hand[1]);
      if (holder) return { holder, dealership: e.dealershipName ?? "a dealership", note: hand[2]!, at: Date.parse(e.at) };
    }
    if (e.agent === "nova" && e.step.startsWith("Admitted ")) return { holder: "nova", dealership: e.dealershipName ?? e.step.replace(/^Admitted /, "").split(" — ")[0]!, note: "reading the website", at: Date.parse(e.at) };
  }
  return null;
}

const STAGE_H = 660;

export function WorkforceStage() {
  const reduced = useReducedMotion() ?? false;
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 1000, h: STAGE_H });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setStage({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const { agents, events, demo } = useAgentStream();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), reduced ? 2000 : 200);
    return () => clearInterval(t);
  }, [reduced]);

  // Orion commands from the top; the floor is a shallow bowl so the chain reads left to right.
  const pos = useMemo(() => {
    const p = { orion: { x: 50, y: 16 } } as Record<AgentKey, { x: number; y: number }>;
    FLOOR.forEach((k, i) => {
      const t = (i - (FLOOR.length - 1) / 2) / ((FLOOR.length - 1) / 2); // -1 … 1
      p[k] = { x: 8 + (84 * i) / (FLOOR.length - 1), y: 71 - 9 * t * t };
    });
    return p;
  }, []);
  const px = (k: AgentKey) => ({ x: (pos[k].x / 100) * stage.w, y: (pos[k].y / 100) * stage.h });

  const { msgs, bursts } = signalsFrom(events, now);
  const activeLink = new Map<string, string>();
  for (const m of msgs) {
    const color = m.tone === "bad" ? "var(--color-bad)" : m.tone === "ok" ? AGENTS[m.from].color : AGENTS.orion.color;
    activeLink.set(`${m.from}-${m.to}`, color);
    activeLink.set(`${m.to}-${m.from}`, color);
  }
  const bubbles = AGENT_KEYS.map((k) => {
    const live = agents.find((a) => a.key === k);
    const latest = events.find((e) => e.agent === k);
    const fresh = latest && now - Date.parse(latest.at) < BUBBLE_MS;
    const text = live?.current?.lastStep ?? (fresh ? latest!.step : null);
    return { key: k, text: text ? (text.length > 140 ? `${text.slice(0, 138)}…` : text) : null, status: live?.status ?? "IDLE" };
  });
  const working = agents.filter((a) => a.status === "WORKING").length;
  const baton = useMemo(() => batonFrom(events), [events]);
  const allLinks: [AgentKey, AgentKey][] = [...FLOOR.map((k) => ["orion", k] as [AgentKey, AgentKey]), ...LINKS];

  // Status bubbles in pixels: Orion's to its right, the floor's above each node, then nudged
  // apart until no two rectangles overlap and all stay inside the stage.
  const placed: { key: AgentKey; x: number; y: number; w: number; h: number; text: string }[] = [];
  for (const b of bubbles) {
    if (!b.text) continue;
    const { x: nx, y: ny } = px(b.key);
    const { w, h } = bubbleSize(b.text);
    const nodeR = b.key === "orion" ? 44 : 31;
    let x: number;
    let y: number;
    if (b.key === "orion") {
      x = nx + nodeR + 18;
      y = ny - h / 2;
    } else {
      x = nx - w / 2;
      y = ny - nodeR - 14 - h;
    }
    x = Math.max(8, Math.min(stage.w - w - 8, x));
    y = Math.max(30, Math.min(stage.h - h - 30, y));
    for (let pass = 0; pass < 6; pass++) {
      for (const o of placed) {
        const overlap = x < o.x + o.w + 8 && x + w + 8 > o.x && y < o.y + o.h + 8 && y + h + 8 > o.y;
        if (!overlap) continue;
        y = o.y - h - 10; // climb above the other bubble
        if (y < 30) {
          y = o.y + o.h + 10;
        }
        y = Math.max(30, Math.min(stage.h - h - 30, y));
      }
    }
    placed.push({ key: b.key, x, y, w, h, text: b.text });
  }
  const lastEvent = events[0];
  const orionPx = px("orion");

  return (
    <div ref={stageRef} className="hud relative overflow-hidden rounded-md border border-line" style={{ background: "radial-gradient(ellipse 70% 45% at 50% 18%, #10234a 0%, #0a1226 45%, #05080f 100%)", height: STAGE_H, "--agent": AGENTS.orion.color } as React.CSSProperties}>
      {/* the floor: a perspective grid under the agents */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[62%]" style={{ perspective: "700px", perspectiveOrigin: "50% 0%" }}>
        <div className="absolute inset-x-[-40%] bottom-[-10%] top-0" style={{ transform: "rotateX(62deg)", transformOrigin: "50% 100%", backgroundImage: "linear-gradient(rgba(125,211,252,0.16) 1px, transparent 1px), linear-gradient(90deg, rgba(125,211,252,0.16) 1px, transparent 1px)", backgroundSize: "56px 56px", maskImage: "linear-gradient(to top, rgba(0,0,0,0.9), transparent 85%)", WebkitMaskImage: "linear-gradient(to top, rgba(0,0,0,0.9), transparent 85%)" }} />
      </div>
      {/* scanlines and a faint star field */}
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.07]" style={{ backgroundImage: "radial-gradient(#9fe1ff 0.7px, transparent 0.7px)", backgroundSize: "26px 26px" }} />
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.05]" style={{ backgroundImage: "repeating-linear-gradient(0deg, transparent 0 3px, #000 3px 4px)" }} />
      {/* Orion's command halo and the light it throws on the floor */}
      <div aria-hidden className="pointer-events-none absolute" style={{ left: orionPx.x, top: orionPx.y, width: 0, height: 0 }}>
        <div className="absolute" style={{ left: -260, top: 20, width: 520, height: 360, background: "radial-gradient(ellipse at 50% 0%, rgba(125,211,252,0.18), transparent 60%)" }} />
        {[150, 220, 300].map((d, i) => (
          <motion.div key={d} className="absolute rounded-full border" style={{ width: d, height: d, left: -d / 2, top: -d / 2, borderColor: `#7dd3fc${i === 0 ? "66" : i === 1 ? "33" : "1f"}`, borderStyle: i === 1 ? "dashed" : "solid" }} animate={reduced ? undefined : { rotate: i % 2 ? -360 : 360 }} transition={{ duration: 50 + i * 25, repeat: Infinity, ease: "linear" }} />
        ))}
      </div>

      <div className="absolute left-4 top-3 z-10 flex items-center gap-3">
        <span className="num text-[11px] uppercase tracking-[0.14em]" style={{ color: AGENTS.orion.color }}>
          Workforce network
        </span>
        <span className="num text-[11px] uppercase tracking-[0.12em] text-muted">{working} working</span>
        {baton ? (
          <span className="num flex items-center gap-2 text-[11px] uppercase tracking-[0.12em]" style={{ color: AGENTS[baton.holder].color }}>
            <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: AGENTS[baton.holder].color, boxShadow: `0 0 8px ${AGENTS[baton.holder].color}` }} />
            relay · {AGENTS[baton.holder].name} has {baton.dealership}
          </span>
        ) : (
          <span className="num text-[11px] uppercase tracking-[0.12em] text-faint">relay · waiting for the next dealership</span>
        )}
        {demo ? <span className="num rounded-sm bg-warn px-1.5 text-[10px] uppercase tracking-[0.1em] text-paper">demo</span> : null}
      </div>
      <div className="absolute bottom-2 left-4 right-4 z-10 flex items-center justify-between gap-4 num text-[10px] uppercase tracking-[0.12em] text-faint">
        <span>every signal is a recorded event</span>
        {lastEvent ? (
          <span className="truncate">
            last · {new Date(lastEvent.at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })} · {AGENTS[lastEvent.agent as AgentKey]?.name ?? lastEvent.agent}: {lastEvent.step.slice(0, 60)}
          </span>
        ) : null}
      </div>

      {/* conduits: command lines from Orion, work lines along the floor; active ones glow and flow */}
      <svg className="absolute inset-0 h-full w-full" aria-hidden>
        <defs>
          <filter id="wf-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2.5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {allLinks.map(([a, b]) => {
          const on = activeLink.get(`${a}-${b}`);
          const base = a === "orion" ? AGENTS.orion.color : AGENTS[a].color;
          const A = px(a);
          const B = px(b);
          const command = a === "orion";
          return (
            <g key={`${a}-${b}`}>
              <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} stroke={base} strokeOpacity={command ? 0.14 : 0.3} strokeWidth={command ? 1 : 1.6} strokeDasharray={command ? "2 6" : "6 10"}>
                {!reduced && !command ? <animate attributeName="stroke-dashoffset" from="0" to="-32" dur="6s" repeatCount="indefinite" /> : null}
              </line>
              {on ? (
                <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} stroke={on} strokeOpacity={0.95} strokeWidth={2.4} strokeDasharray="10 8" filter="url(#wf-glow)">
                  {!reduced ? <animate attributeName="stroke-dashoffset" from="0" to="-36" dur="0.6s" repeatCount="indefinite" /> : null}
                </line>
              ) : null}
            </g>
          );
        })}
      </svg>

      {/* passes: a packet with a tail travels the conduit, the receiver ripples, the message lands beside it */}
      <AnimatePresence>
        {msgs.map((m, i) => {
          const A = px(m.from);
          const B = px(m.to);
          const color = m.tone === "bad" ? "var(--color-bad)" : m.tone === "ok" ? AGENTS[m.from].color : AGENTS.orion.color;
          const age = (now - m.at) / 1000;
          const landed = reduced || age >= TRAVEL_S;
          const stack = msgs.slice(0, i).filter((o) => o.to === m.to).length;
          const chipY = m.to === "orion" ? B.y + 58 + stack * 30 : B.y + 48 + stack * 30;
          const chipX = Math.max(8, Math.min(stage.w - 8, B.x));
          const align = B.x < stage.w * 0.2 ? "0%" : B.x > stage.w * 0.8 ? "-100%" : "-50%";
          return (
            <div key={m.id} className="pointer-events-none absolute inset-0 z-20">
              {!reduced && !landed ? (
                <>
                  {[0, 0.09, 0.18, 0.27].map((delay, n) => (
                    <motion.span key={n} aria-hidden className="absolute rounded-full" style={{ width: n === 0 ? 12 : 8 - n, height: n === 0 ? 12 : 8 - n, background: n === 0 ? "#fff" : color, boxShadow: n === 0 ? `0 0 14px 4px ${color}` : `0 0 8px 2px ${color}`, translateX: "-50%", translateY: "-50%" }} initial={{ left: A.x, top: A.y, opacity: 0 }} animate={{ left: [A.x, B.x], top: [A.y, B.y], opacity: [0, 1, 1, 0.2] }} transition={{ duration: TRAVEL_S, delay, ease: "easeInOut", times: [0, 0.15, 0.85, 1] }} />
                  ))}
                </>
              ) : null}
              {landed && !reduced && age < TRAVEL_S + 1.4 ? <motion.span aria-hidden className="absolute rounded-full border-2" style={{ left: B.x, top: B.y, width: 70, height: 70, translateX: "-50%", translateY: "-50%", borderColor: color }} initial={{ scale: 0.6, opacity: 1 }} animate={{ scale: 2.4, opacity: 0 }} transition={{ duration: 1.2, ease: "easeOut" }} /> : null}
              {landed ? (
                <motion.div className="absolute whitespace-nowrap rounded-md border px-2.5 py-1 text-[12.5px] font-medium" style={{ left: chipX, top: chipY, translateX: align, borderColor: color, background: "#070b14f0", color: "var(--color-text)", boxShadow: `0 0 16px ${color}66, inset 0 0 0 1px ${color}22` }} initial={reduced ? false : { opacity: 0, y: -6, scale: 0.94 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.3 }}>
                  <span className="num mr-1.5 text-[10px] uppercase tracking-[0.12em]" style={{ color }}>
                    {AGENTS[m.from].name} → {AGENTS[m.to].name}
                  </span>
                  {m.label}
                </motion.div>
              ) : null}
            </div>
          );
        })}
      </AnimatePresence>

      {/* bursts: a ring that expands from a node for each step it records */}
      <AnimatePresence>
        {!reduced
          ? bursts.map((b) => {
              const p = px(b.agent);
              const color = b.kind === "task.blocked" ? "var(--color-warn)" : AGENTS[b.agent].color;
              return <motion.span key={b.id} aria-hidden className="pointer-events-none absolute z-[5] rounded-full border-2" style={{ left: p.x, top: p.y, width: 62, height: 62, translateX: "-50%", translateY: "-50%", borderColor: color }} initial={{ scale: 1, opacity: 0.9 }} animate={{ scale: 2.2, opacity: 0 }} exit={{ opacity: 0 }} transition={{ duration: 1.2, ease: "easeOut" }} />;
            })
          : null}
      </AnimatePresence>

      {/* status bubbles, laid out so none covers another */}
      <AnimatePresence>
        {placed.map((b) => {
          const a = AGENTS[b.key];
          return (
            <motion.div key={b.key} initial={reduced ? false : { opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1, left: b.x, top: b.y }} exit={reduced ? undefined : { opacity: 0 }} transition={{ duration: reduced ? 0 : 0.25 }} className="absolute z-30 rounded-md border px-3 py-1.5 text-[13px] leading-snug" style={{ left: b.x, top: b.y, width: b.w, borderColor: `${a.color}aa`, background: "#0a0d16f2", color: "var(--color-text)", boxShadow: `0 0 14px ${a.color}33` }}>
              <span className="num mr-2 text-[10px] uppercase tracking-[0.14em]" style={{ color: a.color }}>
                {a.name}
              </span>
              {b.text}
            </motion.div>
          );
        })}
      </AnimatePresence>

      {/* the agents: Orion on its pedestal, the floor in relay order */}
      {AGENT_KEYS.map((k) => {
        const a = AGENTS[k];
        const b = bubbles.find((x) => x.key === k)!;
        const p = px(k);
        const size = k === "orion" ? 88 : 62;
        return (
          <div key={k} className="absolute z-10 flex flex-col items-center" style={{ left: p.x, top: p.y, transform: "translate(-50%, -50%)" }}>
            <Link href={`/agents/${k}`} className="relative block rounded-full" aria-label={`${a.name} workspace`}>
              {b.status === "WORKING" && !reduced ? <motion.span aria-hidden className="absolute inset-0 rounded-full" style={{ boxShadow: `0 0 0 2px ${a.color}` }} animate={{ scale: [1, 1.55], opacity: [0.8, 0] }} transition={{ duration: 1.5, repeat: Infinity, ease: "easeOut" }} /> : null}
              {baton?.holder === k ? <span aria-hidden className="absolute -inset-[8px] rounded-full border-2 border-dashed" style={{ borderColor: a.color, boxShadow: `0 0 18px ${a.color}77` }} /> : null}
              {/* a soft landing pad under each agent on the floor */}
              {k !== "orion" ? <span aria-hidden className="absolute left-1/2 top-full h-3 w-16 -translate-x-1/2 rounded-[100%] opacity-70" style={{ background: `radial-gradient(ellipse at center, ${a.color}66, transparent 70%)` }} /> : null}
              <AgentAvatar agent={a} size={size} ring={b.status} />
            </Link>
            <div className="num mt-1.5 text-[10.5px] uppercase tracking-[0.16em]" style={{ color: b.status === "IDLE" ? "var(--color-muted)" : a.color }}>
              {a.name}
            </div>
            {k === "orion" ? <div className="num text-[9px] uppercase tracking-[0.18em] text-faint">command</div> : null}
            {baton?.holder === k ? (
              <div className="mt-0.5 max-w-[150px] truncate text-center text-[11.5px] leading-tight" style={{ color: a.color }} title={`${baton.dealership} — ${baton.note}`}>
                holding {baton.dealership}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
