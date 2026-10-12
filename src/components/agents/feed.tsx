"use client";

import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AGENTS, type AgentKey } from "@/domain/agents";
import { Elapsed } from "../agent-ui";
import { useAgent, useAgentEvents, useAgentStream } from "./stream";
import type { FeedEvent } from "./types";

const DOT: Record<string, string> = { DONE: "var(--color-good)", ERROR: "var(--color-bad)", BLOCKED: "var(--color-warn)", INFO: "var(--color-faint)" };
const KIND_LABEL: Record<string, string> = { "task.created": "created", "task.started": "started", "finding.created": "finding", "evidence.saved": "evidence", "response.received": "reply", "task.failed": "failed", "task.completed": "done", "task.blocked": "blocked", "task.scheduled": "parked" };

export function EventRow({ e, showAgent, reduced }: { e: FeedEvent; showAgent?: boolean; reduced: boolean }) {
  const agent = AGENTS[e.agent as AgentKey];
  const kind = KIND_LABEL[e.kind];
  return (
    <motion.li layout={!reduced} initial={reduced ? false : { opacity: 0, y: -10, backgroundColor: "rgba(30,120,255,0.18)" }} animate={{ opacity: 1, y: 0, backgroundColor: "rgba(30,120,255,0)" }} exit={reduced ? undefined : { opacity: 0 }} transition={{ duration: reduced ? 0 : 0.5, backgroundColor: { duration: reduced ? 0 : 2.4 } }} className="grid grid-cols-[76px_minmax(0,1fr)] gap-3 border-b border-line-soft px-4 py-2.5 text-[14px] last:border-b-0">
      <span className="num pt-px text-[12px] text-muted">{new Date(e.at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</span>
      <span className="min-w-0">
        <span className="mr-2 inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ background: DOT[e.status] ?? DOT.INFO }} />
        {showAgent && agent ? (
          <Link href={`/agents/${agent.key}`} className="mr-2 font-medium hover:underline" style={{ color: agent.color }}>
            {agent.name}
          </Link>
        ) : null}
        <span className={`break-words ${e.status === "ERROR" ? "text-bad" : ""}`}>{e.step}</span>
        {kind ? <span className="num ml-2 rounded-sm border border-line px-1 text-[9.5px] uppercase tracking-[0.08em] text-faint">{kind}</span> : null}
        {e.demo ? <span className="num ml-1 rounded-sm bg-warn px-1 text-[9.5px] uppercase tracking-[0.08em] text-paper">demo</span> : null}
        {e.dealershipName ? (
          e.demo ? (
            <span className="ml-2 text-muted">· {e.dealershipName}</span>
          ) : (
            <Link href={`/dealerships/${e.dealershipId}`} className="ml-2 text-muted hover:underline">
              · {e.dealershipName}
            </Link>
          )
        ) : null}
        {e.evidenceId && !e.demo ? (
          <a href={`/api/evidence/${e.evidenceId}`} target="_blank" rel="noreferrer" className="ml-2 text-blue-light hover:underline">
            view
          </a>
        ) : null}
        {e.detail ? <span className="block break-all text-[12.5px] leading-snug text-faint">{e.detail}</span> : null}
      </span>
    </motion.li>
  );
}

/** The activity list, animated as events arrive over the stream. */
export function AgentFeed({ agentKey, showAgent = false, limit = 50, events: override }: { agentKey?: AgentKey; showAgent?: boolean; limit?: number; events?: FeedEvent[] }) {
  const reduced = useReducedMotion() ?? false;
  const streamed = useAgentEvents(agentKey);
  const events = (override ?? streamed).slice(0, limit);
  const { transport } = useAgentStream();
  return (
    <div>
      {events.length === 0 ? <p className="px-4 py-5 text-[13px] text-muted">No activity recorded yet.</p> : null}
      <ul>
        <AnimatePresence initial={false}>
          {events.map((e) => (
            <EventRow key={e.id} e={e} showAgent={showAgent} reduced={reduced} />
          ))}
        </AnimatePresence>
      </ul>
      <div className="num border-t border-line-soft px-4 py-1 text-[10px] uppercase tracking-[0.1em] text-faint">{transport === "stream" ? "live stream connected" : transport === "polling" ? "live · polling" : transport === "demo" ? "demo mode · simulated events" : "connecting…"}</div>
    </div>
  );
}

/** The one-line "what is happening now" bar for an agent. */
export function CurrentTaskBar({ agentKey }: { agentKey: AgentKey }) {
  const live = useAgent(agentKey);
  const reduced = useReducedMotion() ?? false;
  const color = AGENTS[agentKey].color;
  return (
    <AnimatePresence initial={false}>
      {live.current ? (
        <motion.div key={live.current.jobRunId} initial={reduced ? false : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={reduced ? undefined : { opacity: 0, height: 0 }} className="overflow-hidden border-b border-line bg-blue-wash text-[13px]">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
            <span className="status-dot-live inline-block h-2 w-2 rounded-full" style={{ background: color }} />
            <span className="text-[14px] font-medium">{live.current.lastStep ?? `Running ${live.current.queue}`}</span>
            {live.current.dealershipName ? <span className="text-muted">{live.current.dealershipName}</span> : null}
            <Elapsed since={live.current.startedAt} className="ml-auto text-muted" />
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
