"use client";

import Link from "next/link";
import { AGENTS, AGENT_KEYS, type AgentKey } from "@/domain/agents";
import { AgentPortrait, Elapsed, StatusPill } from "../agent-ui";
import { useAgentStream } from "./stream";
import type { SceneData } from "./types";
import { WorkforceStage } from "./workforce";

/** The mission-control view: the workforce talking to each other, then the nine cards. */
export function CommandStage({ orionData }: { orionData: SceneData | null }) {
  void orionData;
  return (
    <div className="space-y-4">
      <WorkforceStage />
      <AgentCards />
    </div>
  );
}

export function AgentCards() {
  const { agents, events } = useAgentStream();
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {AGENT_KEYS.map((key) => {
        const a = AGENTS[key];
        const live = agents.find((x) => x.key === key);
        const status = live?.status ?? "IDLE";
        const latest = events.find((e) => e.agent === key);
        const working = status === "WORKING";
        return (
          <Link key={key} href={`/agents/${key}`} className="hud group relative flex gap-4 overflow-hidden rounded-md border border-line bg-surface p-4 transition-colors hover:border-[color:var(--agent)]" style={{ "--agent": a.color, boxShadow: working ? `0 0 28px ${a.color}33` : undefined } as React.CSSProperties}>
            <span aria-hidden className="absolute inset-x-0 top-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${a.color}, transparent)`, opacity: working ? 1 : 0.45 }} />
            <AgentPortrait agent={a} height={124} />
            <div className="min-w-0 flex-1">
              <div className="num text-[11px] uppercase tracking-[0.12em]" style={{ color: a.color }}>
                {a.number} · {a.role}
              </div>
              <div className="text-[19px] font-semibold leading-tight">{a.name}</div>
              <div className="mt-1.5">
                <StatusPill status={status} color={a.color} />
              </div>
              <div className="mt-2 min-h-[40px] text-[13px] leading-snug text-muted">
                {live?.current ? (
                  <>
                    <span className="text-text">{live.current.lastStep ?? "Working"}</span>
                    {live.current.dealershipName ? <span> · {live.current.dealershipName}</span> : null}
                    <span className="ml-2">
                      <Elapsed since={live.current.startedAt} />
                    </span>
                  </>
                ) : key === "echo" && live?.waiting ? (
                  `Watching ${live.waiting} open test${live.waiting === 1 ? "" : "s"} for replies`
                ) : latest ? (
                  <span>
                    <span className="text-faint">Last: </span>
                    {latest.step}
                  </span>
                ) : (
                  a.purpose
                )}
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

export function DemoBanner({ exitHref }: { exitHref: string }) {
  const { demo } = useAgentStream();
  if (!demo) return null;
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-warn bg-[#2a1f08] px-4 py-2 text-[13.5px] text-warn">
      <span className="num rounded-sm bg-warn px-1.5 text-[10.5px] uppercase tracking-[0.1em] text-paper">Demo mode</span>
      <span>Simulated events for showing the interface. The dealership, findings and timings on screen are fictional and nothing is written to the system.</span>
      <Link href={exitHref} className="ml-auto underline">
        Exit demo
      </Link>
    </div>
  );
}

export function StreamBadge() {
  const { transport } = useAgentStream();
  return (
    <span className="num inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.1em] text-faint">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${transport === "stream" ? "status-dot-live bg-good" : transport === "polling" ? "bg-warn" : transport === "demo" ? "bg-warn" : "bg-faint"}`} />
      {transport === "stream" ? "live" : transport === "polling" ? "live · polling" : transport === "demo" ? "demo" : "connecting"}
    </span>
  );
}

export type { AgentKey };
