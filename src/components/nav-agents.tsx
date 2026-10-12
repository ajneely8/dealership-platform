"use client";

import Link from "next/link";
import { AgentAvatar } from "./agent-ui";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AGENTS, AGENT_KEYS, type AgentKey, type AgentStatus } from "@/domain/agents";

type Live = { key: AgentKey; status: AgentStatus; current: { lastStep: string | null; dealershipName: string | null } | null };

/**
 * The nine agents in the side panel, each with a live mark: the ring turns slowly at rest and
 * fast with a glow while the agent works, and the line under the name says what it is doing.
 */
export function NavAgents() {
  const path = usePathname();
  const [live, setLive] = useState<Live[]>([]);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/activity?limit=1", { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as { agents: Live[] };
          if (!stop) setLive(data.agents);
        }
      } catch {
        // next tick
      }
    };
    void tick();
    const t = setInterval(tick, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);
  return (
    <ul className="mt-1 space-y-px">
      {AGENT_KEYS.map((key) => {
        const a = AGENTS[key];
        const l = live.find((x) => x.key === key);
        const status = l?.status ?? "IDLE";
        const active = path.startsWith(`/agents/${key}`);
        return (
          <li key={key}>
            <Link href={`/agents/${key}`} aria-current={active ? "page" : undefined} className={`relative flex items-center gap-2.5 rounded-sm px-2 py-1.5 ${active ? "bg-charcoal-2" : "hover:bg-charcoal-2"}`}>
              {active ? <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5" style={{ background: a.color }} /> : null}
              <AgentAvatar agent={a} size={28} ring={status} />
              <span className="min-w-0 flex-1">
                <span className={`block text-[13px] leading-tight ${active ? "font-medium text-text" : "text-[#c3d2e6]"}`}>{a.name}</span>
                <span className="block truncate text-[10.5px] leading-tight text-faint">{l?.current ? (l.current.lastStep ?? "Working") : status === "IDLE" ? a.role : status.toLowerCase()}</span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
