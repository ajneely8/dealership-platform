"use client";

import { AnimatePresence, motion } from "motion/react";
import { AGENTS } from "@/domain/agents";
import { PRODUCT_LABEL, type Product } from "@/domain/constants";
import type { SceneProps } from "../types";
import { Ambient, Hud, Stage, fade } from "./primitives";

/** BLAZE — evidence claims fly in from the left and assemble into the brief on the right. */
export function BlazeScene({ status, current, events, data, reduced }: SceneProps) {
  const color = AGENTS.blaze.color;
  const working = status === "WORKING";
  const brief = data?.kind === "blaze" ? data.brief : null;
  const writing = working ? events.find((e) => e.jobRunId === current?.jobRunId && /^Writing brief/.test(e.step)) : null;
  const claims = brief?.claims.slice(0, 5) ?? [];
  const name = working ? current?.dealershipName : brief?.dealershipName;

  return (
    <Stage color={color}>
      <Ambient color={color} reduced={reduced} active={working} />
      <div className="relative grid h-full grid-cols-[1fr_1.4fr] gap-3 p-3">
        <div className="flex min-w-0 flex-col">
          <Hud color={color} className="mb-1.5">
            {working ? `Assembling · ${name ?? ""}` : "Evidence"}
          </Hud>
          <ul className="space-y-1">
            <AnimatePresence initial={false}>
              {claims.map((c, i) => (
                <motion.li key={`${c.text}-${i}`} initial={reduced ? false : { opacity: 0, x: -24 }} animate={{ opacity: 1, x: 0 }} exit={reduced ? undefined : { opacity: 0, x: 24 }} transition={{ duration: reduced ? 0 : 0.4, delay: reduced ? 0 : i * 0.12 }} className="flex items-start gap-1.5 rounded-sm border px-2 py-1 text-[11.5px] leading-snug" style={{ borderColor: `${color}44`, background: "#0a0d16" }}>
                  <span className="num mt-px rounded-sm px-1 text-[9px] leading-4" style={{ background: c.kind === "OBSERVED" ? "var(--color-text)" : "transparent", color: c.kind === "OBSERVED" ? "#06080f" : "var(--color-text)", border: c.kind === "OBSERVED" ? undefined : "1px solid var(--color-text)" }}>
                    {c.kind === "OBSERVED" ? "OBS" : "INF"}
                  </span>
                  <span className="truncate">{c.text}</span>
                </motion.li>
              ))}
            </AnimatePresence>
            {claims.length === 0 ? <li className="text-[12px] text-muted">{working ? (writing?.step ?? "Collecting evidence…") : "Nothing to cite yet."}</li> : null}
          </ul>
        </div>
        <motion.div className="flex min-w-0 flex-col overflow-hidden rounded-sm border p-2" style={{ borderColor: `${color}66`, background: "#0a0d16" }} animate={reduced || !working ? undefined : { boxShadow: [`0 0 0px ${color}00`, `0 0 22px ${color}44`, `0 0 0px ${color}00`] }} transition={{ duration: 2.2, repeat: Infinity }}>
          <div className="flex items-center justify-between">
            <Hud color={color}>Sales brief</Hud>
            {brief ? (
              <Hud>
                priority {brief.priority} · {brief.product ? (PRODUCT_LABEL[brief.product as Product] ?? brief.product) : "—"}
              </Hud>
            ) : null}
          </div>
          <AnimatePresence mode="wait">
            {brief ? (
              <motion.div key={brief.generatedAt} {...fade(reduced, 0.3)} className="mt-1.5 space-y-1.5 text-[11.5px] leading-snug">
                <div className="truncate text-[12.5px] font-medium">{brief.dealershipName}</div>
                {brief.mainProblem ? <p className="line-clamp-2">{brief.mainProblem}</p> : null}
                {brief.opener ? (
                  <div className="rounded-sm border px-2 py-1" style={{ borderColor: `${color}44` }}>
                    <Hud className="mb-0.5">Opener</Hud>
                    <p className="line-clamp-3 italic">“{brief.opener}”</p>
                  </div>
                ) : null}
                {brief.nextAction ? (
                  <div className="flex items-center gap-1.5">
                    <Hud>Next</Hud>
                    <span className="truncate">{brief.nextAction}</span>
                  </div>
                ) : null}
              </motion.div>
            ) : (
              <motion.p key="none" {...fade(reduced)} className="m-auto text-[12px] text-muted">
                {working ? "Writing…" : "The brief assembles here once scoring has run."}
              </motion.p>
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    </Stage>
  );
}
