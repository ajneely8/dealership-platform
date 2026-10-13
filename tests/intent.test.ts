import { describe, expect, it } from "vitest";
import { bandFor, readinessFrom, scoreBuyingIntent, type IntentInput } from "@/domain/intent";
import type { ScoringFacts } from "@/domain/scoring/engine";

const now = new Date("2026-10-13T12:00:00Z");
const facts = (patch: Partial<ScoringFacts> = {}): ScoringFacts => ({
  now,
  observation: { id: "obs1", timestamp: now, websiteStatus: "OK", chatPresent: false, chatWorking: null, chatQuality: null, leadFormCount: 1, inventoryPagePresent: true, inventoryAlertsPresent: false, servicePagePresent: true, serviceSchedulerPresent: false, service: null },
  inventory: [],
  interaction: null,
  signals: [],
  social: [],
  groupRooftops: 1,
  ...patch,
});
const input = (patch: Partial<IntentInput> = {}): IntentInput => ({ facts: facts(), contactTitles: [], outcomes: [], receptionist: "UNKNOWN", smsOffered: false, ...patch });

describe("buying-intent score", () => {
  it("treats missing facts as unknown, not as negatives, and reports low confidence", () => {
    const r = scoreBuyingIntent(input({ facts: facts({ observation: null }) }));
    const unknown = r.signals.filter((s) => s.status === "UNKNOWN").map((s) => s.id);
    expect(unknown).toEqual(expect.arrayContaining(["advertising", "follow_up", "after_hours", "interest"]));
    expect(r.score).toBe(0);
    expect(r.confidence).toBe("LOW");
    expect(r.readiness).toBe("NO_DEMONSTRATED_INTEREST");
  });

  it("scores the rubric and keeps readiness apart from the score", () => {
    const r = scoreBuyingIntent(
      input({
        facts: facts({
          groupRooftops: 3,
          social: [{ id: "s1", platform: "FACEBOOK", postsLast30Days: 20, inventoryPostsLast30Days: 8, customerQuestions: 2, unansweredQuestions: 1, adActivity: true, confidence: "HIGH" }],
          signals: [{ id: "g1", type: "BDC_HIRING", detectedAt: now, confidence: "HIGH", kind: "OBSERVED" }],
          interaction: { id: "i1", submittedAt: new Date(now.getTime() - 3 * 86_400_000), closed: true, responses: [] },
        }),
        contactTitles: ["General Manager"],
      }),
    );
    // group 20 + ads 15 + hiring 15 + missed follow-up 20 + no after-hours 10 + GM 10 = 90; interest not confirmed
    expect(r.score).toBe(90);
    expect(r.band).toBe("HIGH");
    expect(r.readiness).toBe("NO_DEMONSTRATED_INTEREST");
    expect(r.signals.find((s) => s.id === "interest")!.points).toBe(0);
    expect(r.signals.find((s) => s.id === "follow_up")!.evidence).toEqual([{ type: "interaction", id: "i1" }]);
    expect(r.confidence).toBe("HIGH");
  });

  it("gives no after-hours points when a chat widget, text option or AI receptionist covers it", () => {
    const covered = scoreBuyingIntent(input({ smsOffered: true }));
    expect(covered.signals.find((s) => s.id === "after_hours")!.points).toBe(0);
    const ai = scoreBuyingIntent(input({ receptionist: "AI_RECEPTIONIST" }));
    expect(ai.signals.find((s) => s.id === "after_hours")!.points).toBe(0);
  });

  it("derives readiness from logged outcomes only", () => {
    expect(readinessFrom([])).toBe("NO_DEMONSTRATED_INTEREST");
    expect(readinessFrom(["CALLED"])).toBe("POSSIBLE_OPPORTUNITY");
    expect(readinessFrom(["CALLBACK", "BOOKED_MEETING"])).toBe("CONFIRMED_INTEREST");
    expect(readinessFrom(["NOT_INTERESTED", "BOOKED_MEETING"])).toBe("NOT_INTERESTED");
    const r = scoreBuyingIntent(input({ outcomes: ["SOLD"] }));
    expect(r.signals.find((s) => s.id === "interest")!.points).toBe(10);
  });

  it("bands at 45 and 75", () => {
    expect(bandFor(44)).toBe("LOW");
    expect(bandFor(45)).toBe("MEDIUM");
    expect(bandFor(74)).toBe("MEDIUM");
    expect(bandFor(75)).toBe("HIGH");
  });
});
