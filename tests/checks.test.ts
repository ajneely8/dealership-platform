import { describe, expect, it } from "vitest";
import { assessFit, deriveChecks } from "@/domain/checks";

const noExtra = { chatWorking: null, chatQuality: null, leadFormCount: 1, siteReadable: true, growthHiring: [] as string[] };

const NOW = new Date("2026-10-07T18:00:00Z");
const dealer = { receptionist: "UNKNOWN" as const, receptionistNote: null, receptionistCheckedAt: null, manualChatbot: null, manualChatbotNote: null };
const site = { websiteStatus: "OK", statusDetail: null, chatPresent: true, chatVendor: "CarNow", chatType: "LIVE", leadFormCount: 1, detectedTechnology: [{ name: "CarNow", category: "Chat", evidence: "" }] };

describe("the three questions", () => {
  it("reads chatbot off the website and leaves the rest unknown", () => {
    const c = deriveChecks({ dealership: dealer, observation: site, interaction: null, responses: [], now: NOW });
    expect(c.chatbot).toMatchObject({ answer: "YES", detail: "Live chat (staffed) · CarNow", source: "WEBSITE" });
    expect(c.receptionist).toMatchObject({ answer: "UNKNOWN", source: "NONE" });
    expect(c.followUp).toMatchObject({ answer: "UNKNOWN", source: "WEBSITE" });
    expect(c.followUp.detail).toContain("Tools seen: CarNow");
    // A working-or-untested chatbot with nothing else known is not who we are after.
    expect(assessFit(c, noExtra)).toEqual({ tier: "WEAK", reasons: ["has a chatbot (not tested yet)"] });
  });
  it("says NO chatbot when none was found, UNKNOWN when the site could not be scanned", () => {
    expect(deriveChecks({ dealership: dealer, observation: { ...site, chatPresent: false, chatVendor: null, chatType: null }, interaction: null, responses: [], now: NOW }).chatbot.answer).toBe("NO");
    const blocked = deriveChecks({ dealership: dealer, observation: { ...site, websiteStatus: "BLOCKED", statusDetail: "HTTP 403" }, interaction: null, responses: [], now: NOW });
    expect(blocked.chatbot.answer).toBe("UNKNOWN");
    expect(blocked.chatbot.detail).toContain("blocks automated visitors");
    expect(blocked.followUp.detail).toContain("Submit their form yourself");
  });
  it("a blocked site can be answered by hand", () => {
    const byHand = deriveChecks({ dealership: { ...dealer, manualChatbot: "NO", manualChatbotNote: "Looked on 10/7" }, observation: { ...site, websiteStatus: "BLOCKED", statusDetail: "HTTP 403" }, interaction: null, responses: [], now: NOW });
    expect(byHand.chatbot).toMatchObject({ answer: "NO", source: "MANUAL", detail: "Checked by hand — Looked on 10/7" });
    // A readable site keeps the scanner's answer even if a manual one is set.
    expect(deriveChecks({ dealership: { ...dealer, manualChatbot: "NO", manualChatbotNote: null }, observation: site, interaction: null, responses: [], now: NOW }).chatbot.source).toBe("WEBSITE");
  });
  it("receptionist comes only from a recorded phone call", () => {
    const ai = deriveChecks({ dealership: { receptionist: "AI_RECEPTIONIST", receptionistNote: "Answered as 'Ava'", receptionistCheckedAt: NOW, manualChatbot: null, manualChatbotNote: null }, observation: site, interaction: null, responses: [], now: NOW });
    expect(ai.receptionist).toMatchObject({ answer: "YES", source: "PHONE_CALL" });
    expect(ai.receptionist.detail).toContain("AI receptionist — Answered as 'Ava'");
    const vm = deriveChecks({ dealership: { receptionist: "VOICEMAIL", receptionistNote: null, receptionistCheckedAt: NOW, manualChatbot: null, manualChatbotNote: null }, observation: site, interaction: null, responses: [], now: NOW });
    expect(vm.receptionist.answer).toBe("NO");
    expect(assessFit(vm, noExtra).reasons).toContain("no AI receptionist");
  });
  it("lead follow-up is judged by the live test", () => {
    const sent = new Date(NOW.getTime() - 3 * 3_600_000);
    const fast = deriveChecks({ dealership: dealer, observation: site, interaction: { status: "MONITORING", submittedAt: sent, firstResponseSeconds: 240 }, responses: [{ channel: "SMS", responseSeconds: 240, humanOrAutomation: "AUTOMATION" }], now: NOW });
    expect(fast.followUp).toMatchObject({ answer: "YES", source: "LIVE_TEST" });
    expect(fast.followUp.detail).toBe("First reply in 4 min · text in 4 min");
    const slow = deriveChecks({ dealership: dealer, observation: site, interaction: { status: "MONITORING", submittedAt: sent, firstResponseSeconds: 8040 }, responses: [{ channel: "PHONE", responseSeconds: 8040, humanOrAutomation: "HUMAN" }], now: NOW });
    expect(slow.followUp.answer).toBe("NO");
    expect(slow.followUp.detail).toBe("First reply in 2h 14m · no text message · person reached out in 2h 14m");
    const silent = deriveChecks({ dealership: dealer, observation: site, interaction: { status: "MONITORING", submittedAt: sent, firstResponseSeconds: null }, responses: [], now: NOW });
    expect(silent.followUp).toMatchObject({ answer: "NO" });
    expect(silent.followUp.detail).toContain("still watching");
    const early = deriveChecks({ dealership: dealer, observation: site, interaction: { status: "MONITORING", submittedAt: new Date(NOW.getTime() - 600_000), firstResponseSeconds: null }, responses: [], now: NOW });
    expect(early.followUp.answer).toBe("UNKNOWN");
  });
  it("fit: no chatbot, no follow-up and growth hiring is a strong fit", () => {
    const c = deriveChecks({ dealership: { receptionist: "NO_ANSWER", receptionistNote: null, receptionistCheckedAt: NOW, manualChatbot: null, manualChatbotNote: null }, observation: { ...site, chatPresent: false }, interaction: { status: "COMPLETED", submittedAt: new Date(NOW.getTime() - 86_400_000 * 3), firstResponseSeconds: null }, responses: [], now: NOW });
    const fit = assessFit(c, { ...noExtra, growthHiring: ["Sales Manager", "Receptionist"] });
    expect(fit.tier).toBe("STRONG");
    expect(fit.reasons).toEqual(["no chatbot", "no AI receptionist", "slow or missing lead follow-up", "hiring: Sales Manager, Receptionist"]);
  });
  it("fit: a working chatbot is a weak fit; a broken one or no lead form is an opportunity", () => {
    const c = deriveChecks({ dealership: dealer, observation: site, interaction: null, responses: [], now: NOW });
    expect(assessFit(c, { ...noExtra, chatWorking: true }).tier).toBe("WEAK");
    expect(assessFit(c, { ...noExtra, chatWorking: false })).toMatchObject({ tier: "POSSIBLE", reasons: ["chatbot is weak or broken"] });
    expect(assessFit(c, { ...noExtra, chatQuality: 20 }).reasons[0]).toBe("chatbot is weak or broken");
    expect(assessFit(c, { ...noExtra, chatWorking: true, leadFormCount: 0 })).toMatchObject({ tier: "POSSIBLE", reasons: ["chatbot works", "no lead form"] });
    const unknown = deriveChecks({ dealership: dealer, observation: null, interaction: null, responses: [], now: NOW });
    expect(assessFit(unknown, { ...noExtra, siteReadable: false, leadFormCount: null }).tier).toBe("UNKNOWN");
  });
});
