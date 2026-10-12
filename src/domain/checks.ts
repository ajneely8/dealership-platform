import type { Dealership, ResponseRow, TestInteraction, WebsiteObservation } from "@/db/schema";
import { RECEPTIONIST_LABEL } from "./constants";
import { formatDuration } from "./response-timing";

/**
 * The three questions a salesperson actually asks about a dealership. Everything else in the
 * system feeds these. Each answer is YES / NO / UNKNOWN with one line of plain-language detail.
 */
export type Answer = "YES" | "NO" | "UNKNOWN";
export type Check = { answer: Answer; detail: string; /** Where the answer came from. */ source: "WEBSITE" | "LIVE_TEST" | "PHONE_CALL" | "MANUAL" | "NONE" };
export type Checks = { chatbot: Check; receptionist: Check; followUp: Check };

/** Vendor categories that mean "some follow-up tool is installed". */
const FOLLOW_UP_CATEGORIES = new Set(["CRM", "Chat"]);

export function deriveChecks(args: {
  dealership: Pick<Dealership, "receptionist" | "receptionistNote" | "receptionistCheckedAt" | "manualChatbot" | "manualChatbotNote">;
  observation: (Pick<WebsiteObservation, "websiteStatus" | "statusDetail" | "chatPresent" | "chatVendor" | "chatType" | "leadFormCount" | "detectedTechnology"> & { chatGrade?: string | null; chatQuality?: number | null }) | null;
  /** Most recent submitted form test, if any. */
  interaction: Pick<TestInteraction, "status" | "submittedAt" | "firstResponseSeconds"> | null;
  responses: Pick<ResponseRow, "channel" | "responseSeconds" | "humanOrAutomation">[];
  now?: Date;
}): Checks {
  const { dealership: d, observation: o, interaction: i, responses } = args;
  const now = args.now ?? new Date();

  // --- Chatbot: read straight off the website -------------------------------
  let chatbot: Check;
  const blocked = o !== null && o.websiteStatus !== "OK";
  if (d.manualChatbot && (blocked || !o)) {
    chatbot = { answer: d.manualChatbot, detail: `Checked by hand${d.manualChatbotNote ? ` — ${d.manualChatbotNote}` : ""}`, source: "MANUAL" };
  } else if (!o) chatbot = { answer: "UNKNOWN", detail: "Website not scanned yet", source: "NONE" };
  else if (blocked) chatbot = { answer: "UNKNOWN", detail: blockedReason(o.websiteStatus, o.statusDetail), source: "NONE" };
  else if (!o.chatPresent) chatbot = { answer: "NO", detail: "No chat widget found on the site", source: "WEBSITE" };
  else {
    const kind = o.chatType === "AI" ? "AI chat" : o.chatType === "LIVE" ? "Live chat (staffed)" : o.chatType === "RULE_BASED" ? "Scripted chat" : "Chat";
    const grade = o.chatGrade === "GOOD" ? " · tested: good" : o.chatGrade === "BAD" ? " · tested: bad" : "";
    chatbot = { answer: "YES", detail: `${kind}${o.chatVendor ? ` · ${o.chatVendor}` : ""}${grade}${o.chatQuality !== null && o.chatQuality !== undefined && o.chatGrade ? ` (${o.chatQuality}/100)` : ""}`, source: o.chatGrade ? "LIVE_TEST" : "WEBSITE" };
  }

  // --- Receptionist: only a phone call can answer this --------------------------
  let receptionist: Check;
  if (d.receptionist === "UNKNOWN") receptionist = { answer: "UNKNOWN", detail: "Call the dealership and record what answered", source: "NONE" };
  else {
    const when = d.receptionistCheckedAt ? ` · called ${d.receptionistCheckedAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "";
    receptionist = {
      answer: d.receptionist === "AI_RECEPTIONIST" ? "YES" : "NO",
      detail: `${RECEPTIONIST_LABEL[d.receptionist]}${d.receptionistNote ? ` — ${d.receptionistNote}` : ""}${when}`,
      source: "PHONE_CALL",
    };
  }

  // --- Lead follow-up: measured by a live test; the website only hints --------------
  const siteUnreadable = !o || o.websiteStatus !== "OK";
  let followUp: Check;
  const tools = (o?.detectedTechnology ?? []).filter((t) => FOLLOW_UP_CATEGORIES.has(t.category)).map((t) => t.name);
  const toolHint = tools.length ? `Tools seen: ${tools.join(", ")}` : o?.websiteStatus === "OK" ? "No CRM or follow-up tool recognised on the site" : "";
  if (i?.submittedAt) {
    const elapsed = (now.getTime() - i.submittedAt.getTime()) / 1000;
    if (i.firstResponseSeconds !== null) {
      const sms = responses.find((r) => r.channel === "SMS");
      const human = responses.find((r) => r.humanOrAutomation === "HUMAN");
      const parts = [`First reply in ${formatDuration(i.firstResponseSeconds)}`];
      parts.push(sms ? `text in ${formatDuration(sms.responseSeconds)}` : "no text message");
      if (human) parts.push(`person reached out in ${formatDuration(human.responseSeconds)}`);
      followUp = { answer: i.firstResponseSeconds <= 15 * 60 ? "YES" : "NO", detail: parts.join(" · "), source: "LIVE_TEST" };
    } else if (i.status === "COMPLETED" || elapsed >= 24 * 3600) {
      followUp = { answer: "NO", detail: `No reply ${i.status === "COMPLETED" ? "during the whole test" : `after ${formatDuration(Math.floor(elapsed))}`}`, source: "LIVE_TEST" };
    } else if (elapsed >= 3600) {
      followUp = { answer: "NO", detail: `Nothing yet, ${formatDuration(Math.floor(elapsed))} after the lead was sent · still watching`, source: "LIVE_TEST" };
    } else {
      followUp = { answer: "UNKNOWN", detail: `Lead sent ${formatDuration(Math.floor(elapsed))} ago · waiting for a reply`, source: "LIVE_TEST" };
    }
  } else if (siteUnreadable) {
    followUp = { answer: "UNKNOWN", detail: blocked ? "Cannot be tested automatically: the site blocks automated visitors. Submit their form yourself and record the reply by hand." : "Not tested", source: "NONE" };
  } else if (o.leadFormCount === 0) {
    followUp = { answer: "UNKNOWN", detail: `No lead form found to test. ${toolHint}`.trim(), source: "WEBSITE" };
  } else {
    followUp = { answer: "UNKNOWN", detail: `Not tested yet. ${toolHint}`.trim(), source: "WEBSITE" };
  }

  return { chatbot, receptionist, followUp };
}

/** Plain-language reason a site could not be read. */
export function blockedReason(status: string, detail: string | null): string {
  if (status === "BLOCKED") return "This website blocks automated visitors (bot protection). Check it by hand.";
  if (status === "ROBOTS_DISALLOWED") return "This website asks automated visitors not to read it (robots.txt). Check it by hand.";
  if (status === "UNREACHABLE") return `The website did not load${detail ? ` (${detail.replace(/^page.goto: /, "").split(" at ")[0]})` : ""}. Check the address.`;
  return "The website could not be read. Check it by hand.";
}

export type FitTier = "STRONG" | "POSSIBLE" | "WEAK" | "UNKNOWN";
export type Fit = { tier: FitTier; reasons: string[] };

/**
 * Who we want: dealerships with no chatbot, a weak or broken one, no lead form, or no working
 * website, plus hiring for sales/intake/growth roles. A dealership whose chatbot works and that
 * shows no growth hiring is a weak fit, however big it is.
 */
export function assessFit(c: Checks, extra: { chatWorking: boolean | null; chatQuality: number | null; leadFormCount: number | null; siteReadable: boolean; growthHiring: string[] }): Fit {
  const reasons: string[] = [];
  let points = 0;

  if (c.chatbot.answer === "NO") { reasons.push("no chatbot"); points += 2; }
  else if (c.chatbot.answer === "YES" && (extra.chatWorking === false || (extra.chatQuality !== null && extra.chatQuality < 60))) { reasons.push("chatbot is weak or broken"); points += 2; }
  else if (c.chatbot.answer === "YES" && extra.chatWorking === null) reasons.push("has a chatbot (not tested yet)");
  else if (c.chatbot.answer === "YES") reasons.push("chatbot works");

  if (extra.siteReadable && extra.leadFormCount === 0) { reasons.push("no lead form"); points += 1; }
  if (!extra.siteReadable && c.chatbot.source !== "MANUAL") reasons.push("website could not be read");
  if (c.receptionist.answer === "NO") { reasons.push("no AI receptionist"); points += 1; }
  if (c.followUp.answer === "NO") { reasons.push("slow or missing lead follow-up"); points += 2; }
  if (extra.growthHiring.length) { reasons.push(`hiring: ${extra.growthHiring.slice(0, 2).join(", ")}`); points += 1; }

  const known = c.chatbot.answer !== "UNKNOWN" || c.followUp.answer !== "UNKNOWN" || c.receptionist.answer !== "UNKNOWN";
  const tier: FitTier = !known ? "UNKNOWN" : points >= 3 ? "STRONG" : points >= 1 ? "POSSIBLE" : "WEAK";
  return { tier, reasons };
}
