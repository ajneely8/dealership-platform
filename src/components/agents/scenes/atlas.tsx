"use client";

import { motion } from "motion/react";
import { AGENTS } from "@/domain/agents";
import { PRODUCT_LABEL, type Product } from "@/domain/constants";
import type { SceneProps } from "../types";
import { Ambient, Hud, Stage } from "./primitives";

const ORDER: Product[] = ["SUMMARYBOT", "INVENTORY_OUTREACH", "SERVICE_BOT", "SOCIAL_AUTOMATION"];
const BAR: Record<Product, string> = { SUMMARYBOT: "var(--color-summarybot)", INVENTORY_OUTREACH: "var(--color-inventory)", SERVICE_BOT: "var(--color-service)", SOCIAL_AUTOMATION: "var(--color-social)" };

/** ATLAS — product-fit bars that move to the stored scores; the priority counts up. */
export function AtlasScene({ status, current, events, data, reduced }: SceneProps) {
  const color = AGENTS.atlas.color;
  const working = status === "WORKING";
  const target = data?.kind === "atlas" ? data.target : null;
  // While scoring runs, the "Scored: …" event carries the fresh numbers before the page refreshes.
  const scoredEvent = events.find((e) => e.jobRunId && e.jobRunId === current?.jobRunId && /^Scored:/.test(e.step)) ?? events.find((e) => /^Scored:/.test(e.step) && Date.now() - Date.parse(e.at) < 15000);
  const parsed = scoredEvent ? Object.fromEntries([...scoredEvent.step.matchAll(/(summarybot|inventory outreach|service bot|social automation) (\d+)/g)].map((m) => [m[1]!.toUpperCase().replace(" ", "_"), Number(m[2])])) : null;
  const priorityFromEvent = scoredEvent ? Number(/priority (\d+)/.exec(scoredEvent.step)?.[1] ?? NaN) : NaN;
  const score = (p: Product) => parsed?.[p] ?? target?.scores.find((s) => s.product === p)?.score ?? 0;
  const priority = Number.isFinite(priorityFromEvent) ? priorityFromEvent : (target?.priority ?? 0);
  const name = working ? current?.dealershipName : (scoredEvent?.dealershipName ?? target?.dealershipName);

  return (
    <Stage color={color}>
      <Ambient color={color} reduced={reduced} active={working} />
      <div className="relative grid h-full grid-cols-[1fr_150px] gap-3 p-3">
        <div className="flex flex-col justify-center gap-3">
          <Hud color={color}>{working ? `Scoring · ${name ?? ""}` : target ? `Latest scores · ${name}` : "Nothing scored yet"}</Hud>
          {ORDER.map((p, i) => {
            const v = score(p);
            return (
              <div key={p}>
                <div className="mb-0.5 flex items-baseline justify-between text-[12px]">
                  <span>{PRODUCT_LABEL[p]}</span>
                  <motion.span key={`${p}-${v}`} className="num text-[12.5px]" initial={reduced ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
                    {v}
                  </motion.span>
                </div>
                <div className="relative h-2 overflow-hidden rounded-sm" style={{ background: "#141a28" }}>
                  <motion.div className="absolute inset-y-0 left-0 rounded-sm" style={{ background: BAR[p] }} initial={false} animate={{ width: `${v}%` }} transition={{ duration: reduced ? 0 : 0.9, delay: reduced ? 0 : i * 0.08, ease: "easeOut" }} />
                  {working && !reduced ? <motion.div className="absolute inset-y-0 w-10" style={{ background: `linear-gradient(90deg, transparent, ${color}66, transparent)` }} animate={{ left: ["-10%", "110%"] }} transition={{ duration: 1.6, repeat: Infinity, ease: "linear", delay: i * 0.15 }} /> : null}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex flex-col items-center justify-center rounded-sm border" style={{ borderColor: `${color}55`, background: "#0a0d16" }}>
          <Hud>Priority</Hud>
          <motion.div key={priority} className="num text-[40px] font-medium leading-none" style={{ color }} initial={reduced ? false : { scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 240, damping: 18 }}>
            {priority}
          </motion.div>
          <div className="num mt-1 text-[10px] uppercase tracking-[0.12em] text-muted">of 100</div>
          {target ? (
            <div className="num mt-3 text-center text-[10.5px] text-muted">
              {target.observed} observed · {target.inferred} inferred
            </div>
          ) : null}
          {target?.recommended ? (
            <div className="mt-1 text-center text-[11px]" style={{ color }}>
              {PRODUCT_LABEL[target.recommended as Product] ?? target.recommended}
            </div>
          ) : null}
        </div>
      </div>
    </Stage>
  );
}
