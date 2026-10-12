"use client";

import { AnimatePresence, motion } from "motion/react";
import { AGENTS } from "@/domain/agents";
import { Elapsed } from "../../agent-ui";
import type { SceneProps } from "../types";
import { Ambient, Hud, Stage, Tick, fade, fmtSeconds } from "./primitives";

const FORM_STEPS = [
  { label: "Open page", test: /^Opening the form page|^Chat launcher found/ },
  { label: "Fill identity", test: /^Filled the|^Chat asked for contact/ },
  { label: "Capture", test: /^Screenshot saved before|^Asked:/ },
  { label: "Submit", test: /^Inquiry submitted|^Asked:/ },
];

const GRADE_LABEL: Record<string, string> = { GOOD: "good chatbot", BAD: "bad chatbot", NONE: "no chatbot" };
const GRADE_COLOR: Record<string, string> = { GOOD: "var(--color-good)", BAD: "var(--color-bad)", NONE: "var(--color-muted)" };

/**
 * CHARLIE — the conversation as it happens on the left; on the right, every dealership Charlie
 * has worked lately, each with what answered the phone (and what it said) and how the chatbot did.
 */
export function CharlieScene({ status, current, events, data, reduced }: SceneProps) {
  const color = AGENTS.charlie.color;
  const d = data?.kind === "charlie" ? data : null;
  const working = status === "WORKING";
  const jobEvents = current ? events.filter((e) => e.jobRunId === current.jobRunId) : [];
  // Lines: stored transcript first; while a test runs, the live events add to it.
  const lines: { id: string; who: "us" | "them" | "sys"; text: string }[] = (d?.transcript ?? []).map((t, i) => ({ id: `t${i}`, who: t.speaker === "RESEARCHER" ? "us" : t.speaker === "DEALERSHIP" ? "them" : "sys", text: t.message }));
  for (const e of [...jobEvents].reverse()) {
    if (/^Asked: "/.test(e.step)) lines.push({ id: e.id, who: "us", text: e.step.replace(/^Asked: "/, "").replace(/"$/, "") });
    else if (/^Reply: "/.test(e.step)) lines.push({ id: e.id, who: "them", text: e.step.replace(/^Reply: "/, "").replace(/"$/, "") });
    else lines.push({ id: e.id, who: "sys", text: e.step });
  }
  const shown = lines.slice(-7);
  const steps = FORM_STEPS.map((s) => ({ ...s, done: jobEvents.some((e) => s.test.test(e.step)) }));
  const activeIdx = working ? steps.findIndex((s) => !s.done) : -1;
  const formRunning = working && current?.queue === "interaction" && steps.some((s) => s.done);
  const test = d?.test ?? null;
  const monitoring = test?.status === "MONITORING" && test.submittedAt;
  const recent = d?.recent ?? [];

  return (
    <Stage color={color} height={380}>
      <Ambient color={color} reduced={reduced} active={working} />
      <div className="relative grid h-full grid-cols-[1.1fr_1.3fr] gap-3 p-3">
        <div className="flex min-h-0 flex-col gap-3">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-sm border" style={{ borderColor: `${color}55`, background: "#0a0d16" }}>
            <div className="flex items-center justify-between border-b px-2 py-1" style={{ borderColor: `${color}33` }}>
              <Hud color={color}>{working ? `Live · ${current?.dealershipName ?? ""}` : test ? `Latest ${test.testType === "CHAT" ? "chat" : "form"} · ${test.dealershipName}` : "No tests yet"}</Hud>
              {monitoring ? (
                <span className="num text-[12px]" style={{ color }}>
                  <Elapsed since={test.submittedAt!} />
                </span>
              ) : test?.firstResponseSeconds !== null && test?.firstResponseSeconds !== undefined ? (
                <span className="num text-[12px] text-good">reply in {fmtSeconds(test.firstResponseSeconds)}</span>
              ) : test ? (
                <Hud>{test.status.toLowerCase().replace("_", " ")}</Hud>
              ) : null}
            </div>
            <div className="flex flex-1 flex-col justify-end gap-1.5 overflow-hidden p-2">
              <AnimatePresence initial={false}>
                {shown.map((l, i) => (
                  <motion.div key={l.id} {...fade(reduced, i * 0.02)} className={`max-w-[88%] rounded-md px-2 py-1 text-[12px] leading-snug ${l.who === "us" ? "self-end" : l.who === "them" ? "self-start" : "self-center text-[11px] text-muted"}`} style={l.who === "us" ? { background: color, color: "#06080f" } : l.who === "them" ? { background: "#1b2333", border: "1px solid var(--color-line)" } : undefined}>
                    {l.text}
                  </motion.div>
                ))}
              </AnimatePresence>
              {working && !reduced ? (
                <div className="flex gap-1 self-start px-2 py-1">
                  {[0, 1, 2].map((i) => (
                    <motion.span key={i} className="h-1.5 w-1.5 rounded-full bg-muted" animate={{ opacity: [0.2, 1, 0.2] }} transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }} />
                  ))}
                </div>
              ) : null}
              {shown.length === 0 && !working ? <p className="self-center text-[12px] text-muted">Conversations appear here as a test runs.</p> : null}
            </div>
          </div>
          {formRunning ? (
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
              {steps.map((s, i) => (
                <li key={s.label} className="flex items-center gap-1.5">
                  <Tick state={s.done ? "done" : i === activeIdx ? "active" : "todo"} color={color} />
                  <span className={!s.done && i !== activeIdx ? "text-faint" : ""}>{s.label}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="flex min-h-0 flex-col overflow-hidden rounded-sm border" style={{ borderColor: `${color}55`, background: "#0a0d16" }}>
          <div className="flex items-center justify-between border-b px-2 py-1" style={{ borderColor: `${color}33` }}>
            <Hud color={color}>Dealerships · call and chatbot</Hud>
            <Hud>{recent.length ? `last ${recent.length}` : ""}</Hud>
          </div>
          <ol className="min-h-0 flex-1 divide-y overflow-y-auto" style={{ borderColor: `${color}22` }}>
            {recent.length === 0 ? <li className="p-3 text-[12px] text-muted">Each dealership Charlie calls or chats with will be listed here with what was heard and how the chatbot did.</li> : null}
            {recent.map((r) => (
              <li key={r.dealershipId} className="px-2.5 py-2" style={{ borderColor: `${color}22` }}>
                <div className="truncate text-[12.5px] font-medium">{r.dealershipName}</div>
                <div className="mt-1 grid gap-x-3 gap-y-1 text-[11.5px] leading-snug md:grid-cols-2">
                  <div className="min-w-0">
                    <span className="num mr-1.5 text-[9.5px] uppercase tracking-[0.12em] text-muted">Call</span>
                    {r.call ? (
                      <>
                        <span style={{ color }}>{r.call.verdict}</span>
                        {r.call.heard ? <span className="block truncate text-muted" title={r.call.heard}>&ldquo;{r.call.heard}&rdquo;</span> : r.call.note ? <span className="block truncate text-faint" title={r.call.note}>{r.call.note}</span> : null}
                      </>
                    ) : (
                      <span className="text-faint">not called</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <span className="num mr-1.5 text-[9.5px] uppercase tracking-[0.12em] text-muted">Chat</span>
                    {r.chat ? (
                      <>
                        <span style={{ color: r.chat.grade ? GRADE_COLOR[r.chat.grade] : undefined }}>{r.chat.grade ? GRADE_LABEL[r.chat.grade] : r.chat.status.toLowerCase().replace("_", " ")}</span>
                        {r.chat.score !== null && r.chat.grade && r.chat.grade !== "NONE" ? <span className="num ml-1 text-faint">{r.chat.score}/100</span> : null}
                        {r.chat.firstResponseSeconds !== null ? <span className="ml-1 text-faint">· reply in {fmtSeconds(r.chat.firstResponseSeconds)}</span> : null}
                        {r.chat.lines.filter((l) => l.speaker === "DEALERSHIP")[0] ? <span className="block truncate text-muted" title={r.chat.lines.filter((l) => l.speaker === "DEALERSHIP")[0]!.message}>&ldquo;{r.chat.lines.filter((l) => l.speaker === "DEALERSHIP")[0]!.message}&rdquo;</span> : null}
                      </>
                    ) : (
                      <span className="text-faint">no chat test</span>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </Stage>
  );
}
