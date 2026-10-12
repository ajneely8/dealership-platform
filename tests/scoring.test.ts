import { describe, expect, it } from "vitest";
import { DEFAULT_SCORING_CONFIG, DEFAULT_WEIGHTS, RULES } from "@/domain/scoring/config";
import { computePriority, inventoryMovementPct, scoreProducts, type ScoringFacts } from "@/domain/scoring/engine";

const NOW = new Date("2026-10-05T12:00:00Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

const base: ScoringFacts = { now: NOW, observation: null, inventory: [], interaction: null, signals: [], social: [], groupRooftops: 1 };
const observation: NonNullable<ScoringFacts["observation"]> = {
  id: "o1",
  timestamp: ago(2),
  websiteStatus: "OK",
  chatPresent: true,
  chatWorking: null,
  chatQuality: null,
  leadFormCount: 3,
  inventoryPagePresent: true,
  inventoryAlertsPresent: true,
  servicePagePresent: false,
  serviceSchedulerPresent: false,
  service: null,
};
const ids = (f: ScoringFacts, product: keyof ReturnType<typeof scoreProducts>, config = DEFAULT_SCORING_CONFIG) =>
  scoreProducts(f, config)[product].reasons.map((r) => r.ruleId);

describe("scoring configuration", () => {
  it("every rule has a default weight and unique id", () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
    for (const r of RULES) expect(DEFAULT_WEIGHTS[r.id]).toBe(r.defaultPoints);
  });
  it("uses the weights from the specification", () => {
    expect(DEFAULT_WEIGHTS).toMatchObject({
      "sb.no_sms": 25,
      "sb.slow_response": 20,
      "sb.no_response_1h": 30,
      "sb.generic_email": 10,
      "sb.chat_failed": 20,
      "sb.no_chatbot": 25,
      "sb.no_lead_form": 15,
      "sb.growth_hiring": 15,
      "sb.no_follow_up": 15,
      "io.large_inventory": 15,
      "io.high_movement": 15,
      "io.no_alerts": 20,
      "io.bdc_hiring": 20,
      "io.internet_sales_hiring": 15,
      "sv.poor_scheduler": 20,
      "sv.no_service_chat": 15,
      "sv.no_sms": 15,
      "sv.complaints": 20,
      "sv.service_hiring": 15,
      "sv.large_service": 15,
      "so.high_activity": 15,
      "so.inventory_promoted": 15,
      "so.customer_questions": 20,
      "so.unanswered": 25,
      "so.marketing_hiring": 10,
      "so.ads": 15,
    });
  });
});

describe("SummaryBot scoring", () => {
  const interaction = (hoursAgo: number, responses: NonNullable<ScoringFacts["interaction"]>["responses"], closed = false) => ({
    ...base,
    observation,
    interaction: { id: "i1", submittedAt: ago(hoursAgo), closed, responses },
  });
  const email = (seconds: number, extra: Partial<NonNullable<ScoringFacts["interaction"]>["responses"][number]> = {}) => ({
    id: `r${seconds}`,
    channel: "EMAIL" as const,
    responseSeconds: seconds,
    classification: "AUTO_CONFIRMATION" as const,
    personalizationScore: null,
    vehicleReferenced: null,
    ...extra,
  });

  it("scores nothing without evidence", () => {
    const s = scoreProducts(base, DEFAULT_SCORING_CONFIG);
    expect(Object.values(s).map((p) => p.score)).toEqual([0, 0, 0, 0]);
  });
  it("does not claim 'no response' before the hour is up", () => {
    expect(ids(interaction(0.5, []), "SUMMARYBOT")).toEqual(["sb.slow_response"]);
    expect(ids(interaction(0.1, []), "SUMMARYBOT")).toEqual([]);
  });
  it("no response at all after an hour: no SMS + slow + no response = 75", () => {
    const s = scoreProducts(interaction(2, []), DEFAULT_SCORING_CONFIG).SUMMARYBOT;
    expect(s.reasons.map((r) => [r.ruleId, r.points])).toEqual([
      ["sb.no_sms", 25],
      ["sb.slow_response", 20],
      ["sb.no_response_1h", 30],
    ]);
    expect(s.score).toBe(75);
    for (const r of s.reasons) expect(r.evidence).toEqual([{ type: "interaction", id: "i1" }]);
  });
  it("generic email at 18 minutes, no SMS: 25 + 20 + 10", () => {
    const s = scoreProducts(interaction(3, [email(18 * 60)]), DEFAULT_SCORING_CONFIG).SUMMARYBOT;
    expect(s.reasons.map((r) => r.ruleId)).toEqual(["sb.no_sms", "sb.slow_response", "sb.generic_email"]);
    expect(s.score).toBe(55);
    expect(s.reasons.find((r) => r.ruleId === "sb.generic_email")).toMatchObject({ kind: "INFERENCE", evidence: [{ type: "response", id: "r1080" }] });
  });
  it("a fast SMS reply scores nothing", () => {
    const sms = { id: "r1", channel: "SMS" as const, responseSeconds: 90, classification: "HUMAN_FOLLOW_UP" as const, personalizationScore: 80, vehicleReferenced: true };
    expect(ids(interaction(3, [sms, { ...sms, id: "r2", responseSeconds: 4000 }]), "SUMMARYBOT")).toEqual([]);
  });
  it("adds 'no continued follow-up' only after 72 hours or when monitoring closed", () => {
    expect(ids(interaction(30, [email(60)]), "SUMMARYBOT")).not.toContain("sb.no_follow_up");
    expect(ids(interaction(80, [email(60)]), "SUMMARYBOT")).toContain("sb.no_follow_up");
    expect(ids(interaction(30, [email(60)], true), "SUMMARYBOT")).toContain("sb.no_follow_up");
  });
  it("clamps at 100", () => {
    const f = { ...interaction(80, []), observation: { ...observation, chatWorking: false } };
    const s = scoreProducts(f, DEFAULT_SCORING_CONFIG).SUMMARYBOT;
    expect(s.reasons.reduce((a, r) => a + r.points, 0)).toBeGreaterThanOrEqual(100);
    expect(s.score).toBe(100);
    const boosted = scoreProducts(f, { ...DEFAULT_SCORING_CONFIG, weights: { ...DEFAULT_WEIGHTS, "sb.no_sms": 90 } }).SUMMARYBOT;
    expect(boosted.score).toBe(100);
  });
  it("a weight of 0 switches a rule off; edited weights apply", () => {
    const config = { ...DEFAULT_SCORING_CONFIG, weights: { ...DEFAULT_WEIGHTS, "sb.no_sms": 0, "sb.no_response_1h": 40 } };
    const s = scoreProducts(interaction(2, []), config).SUMMARYBOT;
    expect(s.reasons.map((r) => r.ruleId)).toEqual(["sb.slow_response", "sb.no_response_1h"]);
    expect(s.score).toBe(60);
  });
});

describe("Inventory, Service and Social scoring", () => {
  const snap = (id: string, daysAgo: number, total: number, vdpUrls: string[] = []) => ({ id, capturedAt: ago(daysAgo * 24), total, vdpUrls, confidence: "MEDIUM" as const });
  const signal = (type: ScoringFacts["signals"][number]["type"], daysAgo = 2) => ({ id: `s-${type}`, type, detectedAt: ago(daysAgo * 24), confidence: "HIGH" as const, kind: "OBSERVED" as const });

  it("inventory: large stock, no alerts, hiring", () => {
    const f: ScoringFacts = { ...base, observation: { ...observation, inventoryAlertsPresent: false }, inventory: [snap("n", 0, 427)], signals: [signal("BDC_HIRING"), signal("INTERNET_SALES_HIRING")] };
    const s = scoreProducts(f, DEFAULT_SCORING_CONFIG).INVENTORY_OUTREACH;
    expect(s.reasons.map((r) => r.ruleId)).toEqual(["io.large_inventory", "io.no_alerts", "io.bdc_hiring", "io.internet_sales_hiring"]);
    expect(s.score).toBe(70);
    expect(s.reasons[0]!.label).toContain("427 vehicles");
  });
  it("inventory: unknown alert status is not treated as 'no alerts'", () => {
    expect(ids({ ...base, observation: { ...observation, inventoryAlertsPresent: null } }, "INVENTORY_OUTREACH")).toEqual([]);
  });
  it("inventory movement is measured from listing churn, and ignored when snapshots are too close", () => {
    const urls = (from: number) => Array.from({ length: 20 }, (_, i) => `/v/${from + i}`);
    expect(inventoryMovementPct([snap("b", 0, 100, urls(5)), snap("a", 7, 100, urls(0))])).toBe(25);
    expect(inventoryMovementPct([snap("b", 0, 100, urls(5)), snap("a", 1, 100, urls(0))])).toBeNull();
    expect(inventoryMovementPct([snap("b", 0, 120), snap("a", 7, 100)])).toBe(20);
    expect(ids({ ...base, inventory: [snap("b", 0, 100, urls(5)), snap("a", 7, 100, urls(0))] }, "INVENTORY_OUTREACH")).toEqual(["io.high_movement"]);
  });
  it("old signals stop counting", () => {
    expect(ids({ ...base, signals: [signal("BDC_HIRING", 90)] }, "INVENTORY_OUTREACH")).toEqual([]);
  });
  it("service: form-only scheduler with no chat or SMS", () => {
    const service = { servicePageUrl: "/service", schedulerUrl: null, schedulerMode: "FORM_ONLY" as const, schedulerFieldCount: 9, phoneOnly: false, smsOptionVisible: false, specialsPresent: false, chatOnServicePage: false, contactOptions: [], frictionNotes: ["9-field form"] };
    const f: ScoringFacts = { ...base, observation: { ...observation, servicePagePresent: true, service }, signals: [signal("SERVICE_HIRING")] };
    const s = scoreProducts(f, DEFAULT_SCORING_CONFIG).SERVICE_BOT;
    expect(s.reasons.map((r) => r.ruleId)).toEqual(["sv.poor_scheduler", "sv.no_service_chat", "sv.no_sms", "sv.service_hiring"]);
    expect(s.score).toBe(65);
    const embedded: ScoringFacts = { ...f, observation: { ...f.observation!, service: { ...service, schedulerMode: "EMBEDDED", schedulerFieldCount: null, smsOptionVisible: true, chatOnServicePage: true } }, signals: [] };
    expect(ids(embedded, "SERVICE_BOT")).toEqual([]);
  });
  it("social: sums across platforms and needs observations to score", () => {
    const obs = (id: string, platform: string, posts: number, unanswered: number) => ({ id, platform, postsLast30Days: posts, inventoryPostsLast30Days: 4, customerQuestions: 3, unansweredQuestions: unanswered, adActivity: null, confidence: "MEDIUM" as const });
    const s = scoreProducts({ ...base, social: [obs("a", "facebook", 12, 2), obs("b", "instagram", 10, 1)] }, DEFAULT_SCORING_CONFIG).SOCIAL_AUTOMATION;
    expect(s.reasons.map((r) => r.ruleId)).toEqual(["so.high_activity", "so.inventory_promoted", "so.customer_questions", "so.unanswered"]);
    expect(s.score).toBe(75);
    expect(s.reasons[3]!.evidence).toEqual([{ type: "social", id: "a" }, { type: "social", id: "b" }]);
    expect(ids(base, "SOCIAL_AUTOMATION")).toEqual([]);
  });
});

describe("overall priority", () => {
  it("is zero with no product opportunity, and explains every component", () => {
    const p = computePriority(base, scoreProducts(base, DEFAULT_SCORING_CONFIG), DEFAULT_SCORING_CONFIG);
    expect(p.total).toBe(0);
    expect(p.components.map((c) => c.key)).toEqual(["product", "signals", "confidence", "group", "recency"]);
  });
  it("adds product, signals, confidence, group value and recency", () => {
    const f: ScoringFacts = {
      ...base,
      observation,
      interaction: { id: "i1", submittedAt: ago(2), closed: false, responses: [] },
      signals: [{ id: "s1", type: "BDC_HIRING", detectedAt: ago(48), confidence: "HIGH", kind: "OBSERVED" }],
      groupRooftops: 17,
    };
    const scores = scoreProducts(f, DEFAULT_SCORING_CONFIG);
    const p = computePriority(f, scores, DEFAULT_SCORING_CONFIG);
    const byKey = Object.fromEntries(p.components.map((c) => [c.key, c.points]));
    // SummaryBot 90 (incl. growth hiring) × 0.4 + Inventory Outreach 20 × 0.1 = 38
    expect(byKey).toEqual({ product: 38, signals: 5, confidence: 15, group: 10, recency: 10 });
    expect(p.total).toBe(78);
    for (const c of p.components) expect(c.points).toBeLessThanOrEqual(c.max);
  });
  it("is deterministic", () => {
    const f: ScoringFacts = { ...base, observation: { ...observation, inventoryAlertsPresent: false } };
    expect(scoreProducts(f, DEFAULT_SCORING_CONFIG)).toEqual(scoreProducts(f, DEFAULT_SCORING_CONFIG));
  });
});
