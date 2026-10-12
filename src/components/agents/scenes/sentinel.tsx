"use client";

import { AnimatePresence, motion } from "motion/react";
import { AGENTS } from "@/domain/agents";
import type { SceneProps } from "../types";
import { Ambient, Hud, Stage, fade } from "./primitives";

const usd = (n: number) => (n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `$${Math.round(n / 1_000)}k` : `$${Math.round(n).toLocaleString("en-US")}`);
const CONF_LEVEL: Record<string, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };
const SEGMENT: Record<string, string> = { BUDGET: "budget stock", MAINSTREAM: "mainstream stock", PREMIUM: "premium stock", LUXURY: "luxury stock", EXOTIC: "exotic stock", UNKNOWN: "unpriced stock" };

/**
 * SENTINEL — the ledger: the newest estimate large (vehicles a month and gross profit a month),
 * what each sale is worth, a confidence meter that fills as the turnover window grows, and the
 * last dealerships estimated beside it. Every number comes from a stored estimate; while a job
 * runs, its steps stream in under the ledger.
 */
export function SentinelScene({ status, current, events, data, reduced }: SceneProps) {
  const color = AGENTS.sentinel.color;
  const d = data?.kind === "sentinel" ? data : null;
  const working = status === "WORKING";
  const latest = d?.latest[0] ?? null;
  const jobEvents = current ? events.filter((e) => e.jobRunId === current.jobRunId).slice(0, 3) : [];
  const level = latest ? (CONF_LEVEL[latest.confidence] ?? 1) : 0;

  return (
    <Stage color={color} height={300}>
      <Ambient color={color} reduced={reduced} active={working} />
      <div className="relative grid h-full grid-cols-[1.15fr_1fr] gap-3 p-3">
        <div className="flex min-h-0 flex-col overflow-hidden rounded-sm border" style={{ borderColor: `${color}55`, background: "#0a0d16" }}>
          <div className="flex items-center justify-between border-b px-2 py-1" style={{ borderColor: `${color}33` }}>
            <Hud color={color}>{working ? `Estimating · ${current?.dealershipName ?? ""}` : latest ? `Latest estimate · ${latest.dealershipName}` : "No estimates yet"}</Hud>
            {d ? <Hud>{`${d.coverage.estimated} of ${d.coverage.total} dealerships`}</Hud> : null}
          </div>
          <div className="flex flex-1 flex-col justify-center gap-2 px-3 py-2">
            <AnimatePresence mode="wait" initial={false}>
              {latest ? (
                <motion.div key={latest.dealershipId} {...fade(reduced)}>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="num text-[9.5px] uppercase tracking-[0.14em] text-muted">Vehicles sold a month</div>
                      <div className="num text-[28px] font-medium leading-none" style={{ color }}>
                        {latest.unitsLow === latest.unitsHigh ? latest.unitsLow : `${latest.unitsLow}–${latest.unitsHigh}`}
                      </div>
                    </div>
                    <div>
                      <div className="num text-[9.5px] uppercase tracking-[0.14em] text-muted">Gross profit a month</div>
                      <div className="num text-[28px] font-medium leading-none text-text">{latest.profitLow !== null && latest.profitHigh !== null ? `${usd(latest.profitLow)}–${usd(latest.profitHigh)}` : "—"}</div>
                    </div>
                  </div>
                  <div className="mt-1.5 text-[12px] text-muted">
                    {latest.profitPerUnit !== null ? `about ${usd(latest.profitPerUnit)} made on each sale` : "no asking prices read yet, so no money figures"}
                    {latest.grossLow !== null && latest.grossHigh !== null ? ` · ${usd(latest.grossLow)}–${usd(latest.grossHigh)} in sales` : ""}
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-[11px] text-muted">
                    <span className="num uppercase tracking-[0.1em]">{latest.confidence.toLowerCase()} confidence</span>
                    <span className="flex gap-1" aria-hidden>
                      {[1, 2, 3].map((n) => (
                        <motion.span key={n} className="h-1.5 w-7 rounded-sm" style={{ background: n <= level ? color : `${color}33` }} animate={!reduced && working && n === level + 1 ? { opacity: [0.2, 0.8, 0.2] } : undefined} transition={{ duration: 1.4, repeat: Infinity }} />
                      ))}
                    </span>
                    <span className="truncate">
                      {latest.segment ? `${SEGMENT[latest.segment] ?? latest.segment} · ` : ""}
                      {latest.method === "TURNOVER" ? "measured from inventory turnover" : "first guess from lot size"}
                      {latest.onHand !== null ? ` · ${latest.onHand} on the lot` : ""}
                    </span>
                  </div>
                </motion.div>
              ) : (
                <motion.p key="none" {...fade(reduced)} className="text-[12px] text-muted">
                  Each dealership&apos;s monthly units and gross profit, estimated from its own inventory, land here.
                </motion.p>
              )}
            </AnimatePresence>
            {jobEvents.length ? (
              <ul className="mt-1 space-y-0.5 border-t pt-1.5 text-[11px] text-muted" style={{ borderColor: `${color}22` }}>
                {jobEvents.map((e) => (
                  <li key={e.id} className="truncate">
                    {e.step}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>

        <div className="flex min-h-0 flex-col overflow-hidden rounded-sm border" style={{ borderColor: `${color}55`, background: "#0a0d16" }}>
          <div className="border-b px-2 py-1" style={{ borderColor: `${color}33` }}>
            <Hud color={color}>Recent estimates</Hud>
          </div>
          <ol className="min-h-0 flex-1 overflow-y-auto">
            <AnimatePresence initial={false}>
              {(d?.latest ?? []).map((r, i) => (
                <motion.li key={r.dealershipId} {...fade(reduced, i * 0.03)} className="grid grid-cols-[1fr_auto] gap-x-3 border-b px-2.5 py-1.5 text-[11.5px] leading-snug" style={{ borderColor: `${color}1a` }}>
                  <span className="truncate font-medium">{r.dealershipName}</span>
                  <span className="num text-right" style={{ color }}>
                    {r.unitsLow}–{r.unitsHigh}/mo
                  </span>
                  <span className="truncate text-muted">{r.profitLow !== null && r.profitHigh !== null ? `${usd(r.profitLow)}–${usd(r.profitHigh)} gross profit` : "no prices read yet"}</span>
                  <span className="num text-right text-[10px] uppercase tracking-[0.08em] text-faint">{r.confidence.toLowerCase()}</span>
                </motion.li>
              ))}
            </AnimatePresence>
            {!d?.latest.length ? <li className="p-3 text-[12px] text-muted">Nothing estimated yet.</li> : null}
          </ol>
        </div>
      </div>
    </Stage>
  );
}
