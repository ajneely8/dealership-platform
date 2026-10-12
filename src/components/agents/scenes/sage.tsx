"use client";

import { AnimatePresence, motion } from "motion/react";
import { AGENTS } from "@/domain/agents";
import type { SceneProps } from "../types";
import { Ambient, Hud, Stage, fade } from "./primitives";

const PLATFORM_GLYPH: Record<string, string> = { FACEBOOK: "f", INSTAGRAM: "ig", TIKTOK: "tt", YOUTUBE: "yt", X: "x", TWITTER: "x", LINKEDIN: "in" };

/** SAGE — the dealership's public profiles as floating cards; unanswered questions lit up. */
export function SageScene({ status, current, events, data, reduced }: SceneProps) {
  const color = AGENTS.sage.color;
  const working = status === "WORKING";
  const cards = data?.kind === "sage" ? data.cards.slice(0, 6) : [];
  const reading = working ? events.find((e) => e.jobRunId === current?.jobRunId && /^Reading /.test(e.step))?.step.replace(/^Reading /, "").replace(/ profile$/, "") : null;
  const num = (n: number | null) => (n === null ? "—" : n.toLocaleString("en-US"));

  return (
    <Stage color={color}>
      <Ambient color={color} reduced={reduced} active={working} />
      <div className="relative flex h-full flex-col p-3">
        <div className="mb-2 flex items-center justify-between">
          <Hud color={color}>{working ? `Reading ${reading ?? "profiles"} · ${current?.dealershipName ?? ""}` : cards.length ? "Public profiles on file" : "No profiles read yet"}</Hud>
          <Hud>only what a page shows without signing in</Hud>
        </div>
        {cards.length === 0 && !working ? <p className="m-auto text-[12.5px] text-muted">Cards appear here after a social check.</p> : null}
        <div className="grid flex-1 grid-cols-3 gap-2">
          <AnimatePresence initial={false}>
            {cards.map((c, i) => {
              const blocked = c.followers === null && c.posts === null;
              return (
                <motion.div key={c.id} {...fade(reduced, i * 0.05)} className="relative flex flex-col rounded-sm border p-2" style={{ borderColor: c.unanswered ? "var(--color-warn)" : `${color}55`, background: "#0a0d16" }}>
                  <motion.div className="flex h-full flex-col" animate={reduced || !working ? undefined : { y: [0, -3, 0] }} transition={{ duration: 3 + (i % 3), repeat: Infinity, ease: "easeInOut", delay: i * 0.4 }}>
                    <div className="flex items-center gap-1.5">
                      <span className="num inline-flex h-5 min-w-5 items-center justify-center rounded-sm px-1 text-[10px] font-medium" style={{ background: `${color}33`, color }}>
                        {PLATFORM_GLYPH[c.platform] ?? c.platform.slice(0, 2).toLowerCase()}
                      </span>
                      <span className="truncate text-[11.5px]">{c.platform.charAt(0) + c.platform.slice(1).toLowerCase()}</span>
                    </div>
                    <div className="truncate text-[10.5px] text-muted">{c.dealershipName}</div>
                    {blocked ? (
                      <div className="mt-auto text-[11px] text-faint">{c.note ?? "not readable without signing in"}</div>
                    ) : (
                      <>
                        <div className="num mt-1 grid grid-cols-2 gap-x-2 text-[11px]">
                          <span className="text-muted">followers</span>
                          <span className="text-right">{num(c.followers)}</span>
                          <span className="text-muted">posts</span>
                          <span className="text-right">{num(c.posts)}</span>
                          <span className="text-muted">questions</span>
                          <span className="text-right">{num(c.questions)}</span>
                        </div>
                        {c.unanswered ? (
                          <motion.div className="num mt-auto rounded-sm px-1.5 py-0.5 text-[10.5px] font-medium" style={{ background: "var(--color-warn)", color: "#06080f" }} animate={reduced ? undefined : { opacity: [0.8, 1, 0.8] }} transition={{ duration: 2, repeat: Infinity }}>
                            {c.unanswered} unanswered
                          </motion.div>
                        ) : c.note ? (
                          <div className="mt-auto truncate text-[10.5px] text-faint" title={c.note}>
                            {c.note}
                          </div>
                        ) : null}
                      </>
                    )}
                  </motion.div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>
    </Stage>
  );
}
