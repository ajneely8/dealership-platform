import { describe, expect, it } from "vitest";
import { angleIsGrounded } from "@/ai/tasks";
import { buildBrief } from "@/domain/brief";
import { dedupeKeys, findDuplicate, type DedupeExisting } from "@/domain/dedupe";
import { evaluateEligibility, type EligibilityInput } from "@/domain/eligibility";
import { aggregateGroup } from "@/domain/group-intel";
import { classifyResponseByRule, evaluateMilestones, firstResponseSeconds, nextMilestoneAt, responseSeconds } from "@/domain/response-timing";
import { evaluateSuppression, type SuppressionRule } from "@/domain/suppression";
import { normalizeAddress, normalizeDomain, normalizeName, normalizePhone } from "@/lib/normalize";

const NOW = new Date("2026-10-05T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe("normalisation", () => {
  it("normalises domains, phones, addresses and names", () => {
    expect(normalizeDomain("https://WWW.Northside-Ford.com/inventory?x=1")).toBe("northside-ford.com");
    expect(normalizeDomain("northside-ford.com")).toBe("northside-ford.com");
    expect(normalizeDomain("not a url")).toBeNull();
    expect(normalizePhone("+1 (210) 555-0188")).toBe("2105550188");
    expect(normalizePhone("555-0188")).toBeNull();
    expect(normalizeAddress("123 North Main Street, Suite 4")).toBe("123 n main st ste 4");
    expect(normalizeName("Smith Auto Group, LLC")).toBe("smith auto group");
  });
});

describe("duplicate detection", () => {
  const existing: DedupeExisting[] = [
    { id: "a", name: "Northside Ford", ...dedupeKeys({ name: "Northside Ford", website: "northsideford.com", phone: "210-555-0100", address: "1 Main St", city: "Austin", state: "TX", zip: "78701" }) },
    { id: "b", name: "Toyota of Springfield", ...dedupeKeys({ name: "Toyota of Springfield", city: "Springfield", state: "IL", groupId: "g1" }) },
  ];
  const check = (c: Parameters<typeof dedupeKeys>[0]) => findDuplicate(dedupeKeys(c), existing);

  it("matches on domain, phone and address", () => {
    expect(check({ name: "Different", website: "https://www.northsideford.com/used" })?.reason).toBe("DOMAIN");
    expect(check({ name: "Different", phone: "(210) 555-0100" })?.reason).toBe("PHONE");
    expect(check({ name: "Different", address: "1 Main Street", zip: "78701-1234" })?.reason).toBe("ADDRESS");
  });
  it("matches name only with the same location or group", () => {
    expect(check({ name: "Toyota of Springfield", city: "springfield", state: "il" })?.reason).toBe("NAME_LOCATION");
    expect(check({ name: "Toyota of Springfield", groupId: "g1" })?.reason).toBe("NAME_GROUP");
    // Same name in another state is a different rooftop.
    expect(check({ name: "Toyota of Springfield", city: "Springfield", state: "MO" })).toBeNull();
  });
  it("does not match the same street address in a different city", () => {
    expect(check({ name: "Other", address: "1 Main St", city: "Dallas", state: "TX", zip: "75001" })).toBeNull();
  });
});

describe("suppression", () => {
  const target = { dealershipId: "d1", groupId: "g1", normalizedDomain: "northsideford.com", normalizedPhone: "2105550100" };
  const rule = (r: Partial<SuppressionRule>): SuppressionRule => ({
    id: "s",
    scope: "DEALERSHIP",
    dealershipId: null,
    groupId: null,
    domain: null,
    phone: null,
    reason: "MANUAL",
    includeRooftops: true,
    active: true,
    expiresAt: null,
    ...r,
  });

  it("suppresses at dealership, domain and phone level", () => {
    expect(evaluateSuppression(target, [rule({ dealershipId: "d1" })], NOW).suppressed).toBe(true);
    expect(evaluateSuppression(target, [rule({ scope: "DOMAIN", domain: "northsideford.com" })], NOW).suppressed).toBe(true);
    expect(evaluateSuppression(target, [rule({ scope: "PHONE", phone: "2105550100" })], NOW).suppressed).toBe(true);
    expect(evaluateSuppression(target, [rule({ dealershipId: "other" })], NOW).suppressed).toBe(false);
  });
  it("group suppression covers rooftops only when includeRooftops is set", () => {
    expect(evaluateSuppression(target, [rule({ scope: "GROUP", groupId: "g1", reason: "CUSTOMER" })], NOW)).toMatchObject({ suppressed: true, matches: [{ reason: "CUSTOMER" }] });
    expect(evaluateSuppression(target, [rule({ scope: "GROUP", groupId: "g1", includeRooftops: false })], NOW).suppressed).toBe(false);
    expect(evaluateSuppression({ ...target, groupId: null }, [rule({ scope: "GROUP", groupId: "g1" })], NOW).suppressed).toBe(false);
  });
  it("ignores lifted and expired rules", () => {
    expect(evaluateSuppression(target, [rule({ dealershipId: "d1", active: false })], NOW).suppressed).toBe(false);
    expect(evaluateSuppression(target, [rule({ dealershipId: "d1", expiresAt: daysAgo(1) })], NOW).suppressed).toBe(false);
    expect(evaluateSuppression(target, [rule({ dealershipId: "d1", expiresAt: daysAgo(-1) })], NOW).suppressed).toBe(true);
  });
});

describe("interaction eligibility", () => {
  const ok: EligibilityInput = {
    now: NOW,
    testingEnabled: true,
    maxTestsPer30Days: 1,
    cooldownDays: 30,
    dealership: { paused: false, testingApproved: true, normalizedDomain: "northsideford.com" },
    suppressed: false,
    identity: { active: true },
    testType: "FORM",
    lastSubmittedAt: null,
    activeInteractions: 0,
    targetUrl: "https://www.northsideford.com/contact",
    formType: "CONTACT",
    form: { hasProhibitedFields: false, hasCaptcha: false },
  };
  const codes = (patch: Partial<EligibilityInput>) => evaluateEligibility({ ...ok, ...patch }).reasons.map((r) => r.code);

  it("allows a fully compliant test", () => {
    expect(evaluateEligibility(ok)).toMatchObject({ eligible: true, reasons: [] });
  });
  it("skips when testing is disabled, unapproved, paused or suppressed", () => {
    expect(codes({ testingEnabled: false })).toEqual(["TESTING_DISABLED"]);
    expect(codes({ maxTestsPer30Days: 0 })).toEqual(["TEST_LIMIT_ZERO"]);
    expect(codes({ dealership: { ...ok.dealership!, testingApproved: false } })).toEqual(["NOT_APPROVED"]);
    expect(codes({ dealership: { ...ok.dealership!, paused: true } })).toEqual(["PAUSED"]);
    expect(codes({ suppressed: true })).toEqual(["SUPPRESSED"]);
    expect(codes({ dealership: null })).toEqual(["DEALERSHIP_NOT_FOUND"]);
  });
  it("enforces the cooldown and never goes below 30 days", () => {
    expect(codes({ lastSubmittedAt: daysAgo(10) })).toEqual(["COOLDOWN"]);
    expect(codes({ lastSubmittedAt: daysAgo(29), cooldownDays: 7 })).toEqual(["COOLDOWN"]);
    expect(codes({ lastSubmittedAt: daysAgo(31) })).toEqual([]);
    expect(codes({ lastSubmittedAt: daysAgo(31), cooldownDays: 60 })).toEqual(["COOLDOWN"]);
    const r = evaluateEligibility({ ...ok, lastSubmittedAt: daysAgo(10) });
    expect(r.retestAfter?.toISOString().slice(0, 10)).toBe("2026-10-25");
  });
  it("skips when another test is active or the identity is missing/inactive", () => {
    expect(codes({ activeInteractions: 1 })).toEqual(["ACTIVE_TEST"]);
    expect(codes({ identity: null })).toEqual(["NO_IDENTITY"]);
    expect(codes({ identity: { active: false } })).toEqual(["NO_IDENTITY"]);
  });
  it("requires the form to be on the dealership's own domain", () => {
    expect(codes({ targetUrl: "https://some-vendor.com/form" })).toEqual(["DOMAIN_MISMATCH"]);
    expect(codes({ targetUrl: null })).toEqual(["DOMAIN_MISMATCH"]);
    expect(codes({ dealership: { ...ok.dealership!, normalizedDomain: null } })).toEqual(["NO_DOMAIN"]);
  });
  it("never allows finance, trade-in, test-drive or service forms, prohibited fields or CAPTCHAs", () => {
    for (const formType of ["FINANCE", "TRADE_IN", "TEST_DRIVE", "SERVICE_REQUEST", "NEWSLETTER", null] as const) {
      expect(codes({ formType })).toContain("FORM_TYPE_NOT_ALLOWED");
    }
    expect(codes({ form: { hasProhibitedFields: true, hasCaptcha: false } })).toEqual(["PROHIBITED_FIELDS"]);
    expect(codes({ form: { hasProhibitedFields: false, hasCaptcha: true } })).toEqual(["CAPTCHA_PRESENT"]);
  });
  it("a chat test needs a page on the dealership's domain but no form rules", () => {
    expect(codes({ testType: "CHAT", formType: null, form: null, targetUrl: "https://www.northsideford.com/" })).toEqual([]);
    expect(codes({ testType: "CHAT", formType: null, form: null, targetUrl: "https://vendor-chat.test/widget" })).toEqual(["DOMAIN_MISMATCH"]);
    expect(codes({ testType: "CHAT", formType: null, form: null, targetUrl: "https://www.northsideford.com/", lastSubmittedAt: daysAgo(3) })).toEqual(["COOLDOWN"]);
  });
  it("reports every failing rule, not just the first", () => {
    expect(codes({ testingEnabled: false, suppressed: true, activeInteractions: 2 })).toEqual(["TESTING_DISABLED", "SUPPRESSED", "ACTIVE_TEST"]);
  });
});

describe("response timing", () => {
  const submitted = new Date("2026-10-05T09:41:00Z");
  it("computes response seconds and the first response", () => {
    expect(responseSeconds(submitted, new Date("2026-10-05T09:59:00Z"))).toBe(18 * 60);
    expect(responseSeconds(submitted, new Date("2026-10-05T09:40:59Z"))).toBe(0);
    expect(firstResponseSeconds([{ responseSeconds: 8040 }, { responseSeconds: 1080 }])).toBe(1080);
    expect(firstResponseSeconds([])).toBeNull();
  });
  it("only judges milestones that have elapsed", () => {
    const at = (min: number) => new Date(submitted.getTime() + min * 60_000);
    expect(evaluateMilestones(submitted, [], at(3))).toEqual({});
    expect(evaluateMilestones(submitted, [], at(70))).toEqual({ "5m": false, "15m": false, "1h": false });
    expect(evaluateMilestones(submitted, [{ responseSeconds: 18 * 60 }], at(70))).toEqual({ "5m": false, "15m": false, "1h": true, "4h": true, "24h": true, "72h": true });
    expect(evaluateMilestones(submitted, [{ responseSeconds: 60 }], at(2))["5m"]).toBe(true);
  });
  it("schedules the next milestone", () => {
    expect(nextMilestoneAt(submitted, new Date(submitted.getTime() + 6 * 60_000))?.getTime()).toBe(submitted.getTime() + 15 * 60_000);
    expect(nextMilestoneAt(submitted, new Date(submitted.getTime() + 80 * 3_600_000))).toBeNull();
  });
  it("classifies obvious automation by rule and leaves the rest unknown", () => {
    expect(classifyResponseByRule({ channel: "EMAIL", message: "Thank you for contacting us. A member of our team will be in touch.", sender: "noreply@dealer.com", responseSeconds: 40 })).toMatchObject({
      classification: "AUTO_CONFIRMATION",
      humanOrAutomation: "AUTOMATION",
    });
    expect(classifyResponseByRule({ channel: "SMS", message: "Hi, this is Dana. Yes it's here — when can you come by?", sender: "+12105550100", responseSeconds: 1500 })).toMatchObject({
      classification: "UNKNOWN",
      humanOrAutomation: "UNKNOWN",
      callToAction: "Asks for a time",
    });
    expect(classifyResponseByRule({ channel: "PHONE", message: null, sender: "+12105550100", responseSeconds: 8040 }).humanOrAutomation).toBe("HUMAN");
  });
});

describe("sales brief evidence references", () => {
  const brief = buildBrief({
    dealership: { name: "Fixture Motors", inventoryCount: 340, latestInventoryId: "inv1" },
    priorityScore: 70,
    scores: [
      {
        product: "SUMMARYBOT",
        score: 75,
        reasons: [
          { ruleId: "sb.no_sms", points: 25, label: "No SMS response within 60 minutes", kind: "OBSERVED", confidence: "HIGH", evidence: [{ type: "interaction", id: "i1" }] },
          { ruleId: "sb.no_response_1h", points: 30, label: "No response of any kind within 1 hour", kind: "OBSERVED", confidence: "HIGH", evidence: [{ type: "interaction", id: "i1" }] },
          // A reason with no evidence must never become a claim.
          { ruleId: "x", points: 5, label: "Unsupported statement", kind: "INFERENCE", confidence: "LOW", evidence: [] },
        ],
      },
      { product: "INVENTORY_OUTREACH", score: 35, reasons: [{ ruleId: "io.bdc_hiring", points: 20, label: "Hiring BDC staff", kind: "OBSERVED", confidence: "HIGH", evidence: [{ type: "signal", id: "s1" }] }] },
      { product: "SERVICE_BOT", score: 0, reasons: [] },
      { product: "SOCIAL_AUTOMATION", score: 0, reasons: [] },
    ],
    interaction: { id: "i1", submittedAt: new Date("2026-10-05T09:41:00Z"), status: "COMPLETED", firstResponseSeconds: 8040, responses: [{ id: "r1", channel: "PHONE", responseSeconds: 8040, humanOrAutomation: "HUMAN" }] },
    signals: [{ id: "s1", type: "BDC_HIRING", title: "BDC Representative", kind: "OBSERVED", confidence: "HIGH" }],
    retestAfter: null,
    hasGroupWithoutOwnership: false,
  });

  it("every claim maps to stored evidence", () => {
    expect(brief.claims.length).toBeGreaterThan(4);
    for (const c of brief.claims) expect(c.evidence.length, c.text).toBeGreaterThan(0);
    expect(brief.claims.map((c) => c.text)).not.toContain("Unsupported statement");
  });
  it("recommends the top product, a secondary, roles and a next action", () => {
    expect(brief.recommendedProduct).toBe("SUMMARYBOT");
    expect(brief.secondaryProduct).toBe("INVENTORY_OUTREACH");
    expect(brief.mainProblem).toBe("No response of any kind within 1 hour");
    expect(brief.recommendedRoles[0]).toBe("General Manager");
    expect(brief.nextAction).toBe("Contact General Manager");
    expect(brief.templateAngle).toContain("SummaryBot");
  });
  it("rejects AI text that cites unknown claims or invents numbers", () => {
    const claims = brief.claims.map((c) => ({ id: c.id, text: c.text }));
    const inventory = claims.find((c) => c.text.includes("340"))!;
    expect(angleIsGrounded({ mainProblem: "Slow follow-up", salesAngle: "They stock 340 vehicles and follow up slowly.", coldCallOpener: "Hey, this is [your name] with SarvX.", discoveryQuestion: "How do you follow up today?", citedClaimIds: [inventory.id] }, claims).ok).toBe(true);
    expect(angleIsGrounded({ mainProblem: "Slow follow-up", salesAngle: "They lose 40% of leads.", coldCallOpener: "Hey, this is [your name] with SarvX.", discoveryQuestion: "How do you follow up today?", citedClaimIds: [inventory.id] }, claims).ok).toBe(false);
    expect(angleIsGrounded({ mainProblem: "x", salesAngle: "No numbers here.", coldCallOpener: "Hey, this is [your name] with SarvX.", discoveryQuestion: "How do you follow up today?", citedClaimIds: ["c99"] }, claims).ok).toBe(false);
  });
  it("has nothing to recommend when no product scored", () => {
    const empty = buildBrief({ dealership: { name: "X", inventoryCount: null, latestInventoryId: null }, priorityScore: 0, scores: [], interaction: null, signals: [], retestAfter: null, hasGroupWithoutOwnership: false });
    expect(empty).toMatchObject({ recommendedProduct: null, claims: [], templateAngle: null, nextAction: "Review website research" });
  });
});

describe("group intelligence", () => {
  const rooftop = (id: string, priority: number, rules: string[], tech: string[]) => ({
    id,
    priorityScore: priority,
    scanned: true,
    technology: tech.map((name) => ({ name, category: name === "Podium" ? "Chat" : "Website platform" })),
    scores: [{ product: "SERVICE_BOT" as const, score: rules.length * 15, reasons: rules.map((ruleId) => ({ ruleId, label: ruleId })) }],
    hiringSignals: 1,
  });
  it("finds shared technology and systemic problems", () => {
    const { intel, groupScore } = aggregateGroup(
      [rooftop("a", 60, ["sv.no_sms", "sv.no_service_chat"], ["Dealer.com", "Podium"]), rooftop("b", 50, ["sv.no_sms"], ["Dealer.com"]), rooftop("c", 20, [], ["DealerOn"])],
      17,
    );
    expect(intel.sharedTechnology).toEqual([{ name: "Dealer.com", category: "Website platform", count: 2 }]);
    expect(intel.systemicProblems.map((p) => [p.ruleId, p.count])).toEqual([["sv.no_sms", 2]]);
    expect(intel.hiringSignalCount).toBe(3);
    expect(groupScore).toBeGreaterThan(50);
  });
  it("scores an unscored group at zero", () => {
    expect(aggregateGroup([rooftop("a", 0, [], [])], null).groupScore).toBe(0);
  });
});

describe("name from website", () => {
  it("builds a placeholder from the domain and recognises it later", async () => {
    const { nameFromDomain, isPlaceholderName } = await import("@/lib/normalize");
    expect(nameFromDomain("https://www.stoepelford.com")).toBe("Stoepelford");
    expect(nameFromDomain("valmark-chevy.com")).toBe("Valmark Chevy");
    expect(nameFromDomain("not a url")).toBeNull();
    expect(isPlaceholderName("Stoepelford", "https://www.stoepelford.com")).toBe(true);
    expect(isPlaceholderName("Ken Stoepel Ford", "https://www.stoepelford.com")).toBe(false);
  });
});
