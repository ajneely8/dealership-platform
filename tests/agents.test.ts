import { describe, expect, it } from "vitest";
import { AGENTS, AGENT_KEYS, agentForQueue, deriveAgentStatus } from "@/domain/agents";
import { QUEUES } from "@/domain/constants";

const NOW = new Date("2026-10-08T15:00:00Z");
const idle = { paused: false, running: 0, waitingReplies: 0, queued: 0, lastOutcome: null, lastAt: null, now: NOW };

describe("agent status is derived from real state", () => {
  it("is idle when nothing has happened", () => {
    expect(deriveAgentStatus(idle)).toBe("IDLE");
  });
  it("paused wins over everything", () => {
    expect(deriveAgentStatus({ ...idle, paused: true, running: 2 })).toBe("PAUSED");
  });
  it("working while a job runs, waiting while a reply is open, scheduled while queued", () => {
    expect(deriveAgentStatus({ ...idle, running: 1, queued: 5 })).toBe("WORKING");
    expect(deriveAgentStatus({ ...idle, waitingReplies: 1, queued: 5 })).toBe("WAITING");
    expect(deriveAgentStatus({ ...idle, queued: 1 })).toBe("SCHEDULED");
  });
  it("shows error after a failure and completed for ten minutes after success", () => {
    expect(deriveAgentStatus({ ...idle, lastOutcome: "FAILED", lastAt: NOW })).toBe("ERROR");
    expect(deriveAgentStatus({ ...idle, lastOutcome: "COMPLETED", lastAt: new Date(NOW.getTime() - 5 * 60_000) })).toBe("COMPLETED");
    expect(deriveAgentStatus({ ...idle, lastOutcome: "COMPLETED", lastAt: new Date(NOW.getTime() - 11 * 60_000) })).toBe("IDLE");
    expect(deriveAgentStatus({ ...idle, lastOutcome: "SKIPPED", lastAt: NOW })).toBe("IDLE");
  });
});

describe("agent registry", () => {
  it("has nine agents, numbered 01–09, each with its own avatar cell", () => {
    expect(AGENT_KEYS).toHaveLength(9);
    expect(AGENT_KEYS.map((k) => AGENTS[k].number)).toEqual(["01", "02", "03", "04", "05", "06", "07", "08", "09"]);
    const cells = new Set(AGENT_KEYS.map((k) => `${AGENTS[k].avatar.col},${AGENTS[k].avatar.row}`));
    expect(cells.size).toBe(9);
  });
  it("maps every queue to exactly one agent", () => {
    for (const q of QUEUES) expect(AGENT_KEYS).toContain(agentForQueue(q));
    expect(agentForQueue("website-scan")).toBe("nova");
    expect(agentForQueue("interaction")).toBe("charlie");
    expect(agentForQueue("response-check")).toBe("echo");
  });
});
