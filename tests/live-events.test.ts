import { describe, expect, it } from "vitest";
import { demoSceneData, runDemo } from "@/components/agents/demo";
import { AGENT_KEYS } from "@/domain/agents";
import { EVENT_KINDS } from "@/lib/agent-events";

describe("demo mode", () => {
  it("is labelled on every event and never names a real dealership", async () => {
    const seen: { demo?: boolean; dealershipName: string | null; kind: string; agent: string }[] = [];
    const stop = runDemo({ onState: () => {}, onEvent: (e) => seen.push(e) });
    await new Promise((r) => setTimeout(r, 1700));
    stop();
    expect(seen.length).toBeGreaterThan(0);
    for (const e of seen) {
      expect(e.demo).toBe(true);
      expect(e.dealershipName).toBe("[Demo] Example Motors");
      expect(EVENT_KINDS).toContain(e.kind);
      expect(AGENT_KEYS).toContain(e.agent);
    }
  });
  it("has scene facts for all nine agents, all marked as demo by name", () => {
    for (const k of AGENT_KEYS) {
      const d = demoSceneData(k);
      expect(d.kind).toBe(k);
      const text = JSON.stringify(d);
      if (text.includes("dealershipName")) expect(text).toContain("[Demo]");
    }
  });
});

describe("event vocabulary", () => {
  it("covers the lifecycle the interface animates on", () => {
    for (const k of ["task.created", "task.started", "task.step.completed", "finding.created", "evidence.saved", "response.received", "task.failed", "task.completed", "task.blocked"]) expect(EVENT_KINDS).toContain(k);
  });
});
