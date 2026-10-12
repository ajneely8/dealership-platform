"use client";

import { AnimatePresence, motion } from "motion/react";
import { AGENTS } from "@/domain/agents";
import type { SceneProps } from "../types";
import { Ambient, Beam, Hud, Stage, Tick, fade } from "./primitives";

const CHECKS = [
  { key: "home", label: "Homepage", test: /^Opened the homepage|^Could not read the homepage/ },
  { key: "chat", label: "Chat widget", test: /^Chat widget detected|^No chat widget/ },
  { key: "forms", label: "Lead forms", test: /^Lead forms found/ },
  { key: "inventory", label: "Inventory", test: /^Inventory counted|^Inventory page read|^No inventory page/ },
  { key: "service", label: "Service booking", test: /^Service checked|^No service page/ },
  { key: "mobile", label: "Mobile", test: /^Mobile/ },
] as const;

/** NOVA — a holographic browser working through the dealership's site, check by check. */
export function NovaScene({ status, current, events, data, reduced }: SceneProps) {
  const color = AGENTS.nova.color;
  const site = data?.kind === "nova" ? data.site : null;
  const working = status === "WORKING";
  const jobEvents = current ? events.filter((e) => e.jobRunId === current.jobRunId) : [];
  const source = working ? jobEvents : events.filter((e) => e.jobRunId && e.jobRunId === events.find((x) => x.kind === "task.completed")?.jobRunId);
  const lastUrl = source.find((e) => e.detail?.startsWith("http"))?.detail ?? site?.url ?? null;
  const found = (re: RegExp) => source.find((e) => re.test(e.step));
  const states = CHECKS.map((c) => {
    const ev = found(c.test);
    return { ...c, ev, state: ev ? (ev.status === "BLOCKED" || ev.status === "ERROR" ? "blocked" : "done") : "todo" } as const;
  });
  const firstTodo = working ? states.findIndex((s) => s.state === "todo") : -1;
  const summary = (key: string) => {
    if (working || !site) return null;
    switch (key) {
      case "chat":
        return site.chatPresent === null ? "—" : site.chatPresent ? (site.chatVendor ?? "found") : "none";
      case "forms":
        return site.leadFormCount === null ? "—" : `${site.leadFormCount}`;
      case "inventory":
        return site.inventoryCount === null ? "—" : `${site.inventoryCount} vehicles`;
      case "service":
        return site.serviceMode ? site.serviceMode.toLowerCase().replace("_", " ") : "—";
      case "mobile":
        return site.mobileFriendly === null ? "—" : site.mobileFriendly ? "fits a phone" : "issue";
      default:
        return site.websiteStatus === "OK" ? "readable" : (site.websiteStatus?.toLowerCase() ?? "—");
    }
  };
  const done = states.filter((s) => s.state !== "todo").length;

  return (
    <Stage color={color}>
      <Ambient color={color} reduced={reduced} active={working} />
      <div className="relative grid h-full grid-cols-[1.25fr_1fr] gap-3 p-3">
        {/* holographic browser */}
        <motion.div className="flex flex-col overflow-hidden rounded-sm border" style={{ borderColor: `${color}66`, boxShadow: working ? `0 0 24px ${color}33, inset 0 0 24px ${color}11` : `inset 0 0 16px ${color}0d` }} animate={reduced ? undefined : { boxShadow: working ? [`0 0 18px ${color}22`, `0 0 30px ${color}44`, `0 0 18px ${color}22`] : `0 0 0px ${color}00` }} transition={{ duration: 2.4, repeat: working ? Infinity : 0 }}>
          <div className="flex items-center gap-2 border-b px-2 py-1" style={{ borderColor: `${color}44`, background: `${color}14` }}>
            <span className="flex gap-1">
              <i className="h-1.5 w-1.5 rounded-full" style={{ background: `${color}88` }} />
              <i className="h-1.5 w-1.5 rounded-full" style={{ background: `${color}55` }} />
              <i className="h-1.5 w-1.5 rounded-full" style={{ background: `${color}33` }} />
            </span>
            <span className="num truncate text-[11px]" style={{ color }}>
              {lastUrl ?? "no site opened yet"}
            </span>
          </div>
          <div className="relative flex-1 p-2">
            <Beam color={color} reduced={reduced} on={working} />
            {/* wireframe of a dealership page */}
            <div className="space-y-1.5 opacity-80">
              <div className="h-5 rounded-sm" style={{ background: `${color}22` }} />
              <div className="grid grid-cols-3 gap-1.5">
                {[0, 1, 2].map((i) => (
                  <motion.div key={i} className="h-10 rounded-sm" style={{ background: `${color}1a`, border: `1px solid ${color}33` }} animate={reduced || !working ? undefined : { opacity: [0.5, 1, 0.5] }} transition={{ duration: 1.8, repeat: Infinity, delay: i * 0.3 }} />
                ))}
              </div>
              <div className="h-2 w-3/4 rounded-sm" style={{ background: `${color}1f` }} />
              <div className="h-2 w-1/2 rounded-sm" style={{ background: `${color}1f` }} />
              <div className="flex items-end gap-1.5 pt-1">
                <div className="h-8 flex-1 rounded-sm" style={{ border: `1px dashed ${color}55` }} />
                <div className="h-5 w-14 rounded-sm" style={{ background: `${color}44` }} />
              </div>
            </div>
            <AnimatePresence>
              {states.filter((s) => s.state !== "todo").map((s, i) => (
                <motion.span key={s.key} {...fade(reduced, i * 0.03)} className="num absolute rounded-sm px-1 text-[9.5px] uppercase tracking-[0.1em]" style={{ left: 10 + (i % 3) * 64, top: 44 + Math.floor(i / 3) * 36, background: s.state === "done" ? `${color}cc` : "var(--color-warn)", color: "#06080f" }}>
                  {s.label}
                </motion.span>
              ))}
            </AnimatePresence>
          </div>
          <div className="flex items-center justify-between border-t px-2 py-1" style={{ borderColor: `${color}44` }}>
            <Hud color={color}>{working ? `Scanning · ${current?.dealershipName ?? ""}` : site ? `Last scan · ${site.dealershipName}` : "No scans yet"}</Hud>
            <Hud>
              {done}/{CHECKS.length} checks
            </Hud>
          </div>
        </motion.div>
        {/* checklist */}
        <ul className="flex flex-col justify-center gap-1.5">
          {states.map((s, i) => (
            <li key={s.key} className="flex items-center gap-2 text-[12.5px]">
              <Tick state={i === firstTodo ? "active" : s.state} color={color} />
              <span className={s.state === "todo" && i !== firstTodo ? "text-faint" : ""}>{s.label}</span>
              <span className="num ml-auto truncate pl-2 text-[11px] text-muted">{s.ev ? s.ev.step.replace(/^.*?:\s*/, "").slice(0, 28) : summary(s.key)}</span>
            </li>
          ))}
        </ul>
      </div>
    </Stage>
  );
}
