import type { AgentKey } from "./agents";
import type { EvidenceRef, SalesOutcome } from "./constants";
import type { ScoringFacts } from "./scoring/engine";

/**
 * Buying-intent score, 0-100: how likely this dealership is to benefit from and buy AI follow-up,
 * from evidence the agents and the sales team put on file. Every point names its signal, its
 * evidence, when that evidence was seen, how sure we are, and which agent found it. A missing
 * fact is UNKNOWN and scores nothing; it is never treated as a negative finding.
 *
 * Operational fit and purchase interest are kept apart: `readiness` comes only from what a person
 * logged after talking to the dealership, never from the score.
 */
export const INTENT_RULE_VERSION = 1;

export type IntentStatus = "OBSERVED" | "INFERRED" | "UNKNOWN";
export type IntentConfidence = "HIGH" | "MEDIUM" | "LOW";
export type IntentBand = "HIGH" | "MEDIUM" | "LOW";
export type BuyerReadiness = "CONFIRMED_INTEREST" | "POSSIBLE_OPPORTUNITY" | "NO_DEMONSTRATED_INTEREST" | "NOT_INTERESTED";

export type IntentSignal = {
  id: string;
  label: string;
  points: number;
  max: number;
  status: IntentStatus;
  confidence: IntentConfidence | null;
  agent: AgentKey;
  evidence: EvidenceRef[];
  /** When the supporting evidence was captured. */
  evidenceAt: string | null;
  detail: string;
};

export type IntentResult = {
  score: number;
  band: IntentBand;
  readiness: BuyerReadiness;
  confidence: IntentConfidence;
  signals: IntentSignal[];
  ruleVersion: number;
};

export const INTENT_BAND_LABEL: Record<IntentBand, string> = { HIGH: "High priority", MEDIUM: "Medium priority", LOW: "Low priority" };
export const READINESS_LABEL: Record<BuyerReadiness, string> = {
  CONFIRMED_INTEREST: "Confirmed interest",
  POSSIBLE_OPPORTUNITY: "Possible opportunity",
  NO_DEMONSTRATED_INTEREST: "No demonstrated interest",
  NOT_INTERESTED: "Not interested",
};

export function bandFor(score: number): IntentBand {
  return score >= 75 ? "HIGH" : score >= 45 ? "MEDIUM" : "LOW";
}

/** Purchase interest from what people logged, newest outcome first. */
export function readinessFrom(outcomes: readonly SalesOutcome[]): BuyerReadiness {
  const latest = outcomes[0];
  if (!latest) return "NO_DEMONSTRATED_INTEREST";
  if (latest === "NOT_INTERESTED") return "NOT_INTERESTED";
  if (outcomes.some((o) => o === "SOLD" || o === "BOOKED_MEETING" || o === "MEETING_COMPLETED" || o === "PROPOSAL_SENT" || o === "INTERESTED")) return "CONFIRMED_INTEREST";
  return "POSSIBLE_OPPORTUNITY";
}

export type IntentInput = {
  facts: ScoringFacts;
  /** Titles of contacts on file, each with a source. */
  contactTitles: string[];
  /** Sales outcomes, newest first. */
  outcomes: SalesOutcome[];
  /** The receptionist verdict from the phone check. */
  receptionist: string;
  /** Whether the website scan found any after-hours channel (chat, SMS/text) on the site. */
  smsOffered: boolean;
};

const OWNER_TITLE = /\b(owner|general manager|\bgm\b|dealer principal|president|managing partner|principal)\b/i;
const SLOW_SECONDS = 15 * 60;

export function scoreBuyingIntent(input: IntentInput): IntentResult {
  const { facts } = input;
  const signals: IntentSignal[] = [];
  const unknown = (id: string, label: string, max: number, agent: AgentKey, detail: string): IntentSignal => ({ id, label, points: 0, max, status: "UNKNOWN", confidence: null, agent, evidence: [], evidenceAt: null, detail });

  // 1. Privately owned group with 2-5 locations (20)
  if (facts.groupRooftops >= 2 && facts.groupRooftops <= 5) signals.push({ id: "group_2_5", label: "Privately owned group with 2–5 locations", points: 20, max: 20, status: "OBSERVED", confidence: "HIGH", agent: "nova", evidence: [], evidenceAt: facts.now.toISOString(), detail: `${facts.groupRooftops} rooftops on file for this group` });
  else if (facts.groupRooftops > 5) signals.push({ id: "group_2_5", label: "Privately owned group with 2–5 locations", points: 0, max: 20, status: "OBSERVED", confidence: "HIGH", agent: "nova", evidence: [], evidenceAt: facts.now.toISOString(), detail: `${facts.groupRooftops} rooftops: larger than the 2–5 sweet spot` });
  else signals.push({ id: "group_2_5", label: "Privately owned group with 2–5 locations", points: 0, max: 20, status: "OBSERVED", confidence: "MEDIUM", agent: "nova", evidence: [], evidenceAt: facts.now.toISOString(), detail: "single rooftop on file (no group linked)" });

  // 2. Currently advertising vehicles (15)
  const ads = facts.social.filter((s) => s.adActivity === true || (s.inventoryPostsLast30Days ?? 0) >= 4);
  if (ads.length) signals.push({ id: "advertising", label: "Currently advertising vehicles", points: 15, max: 15, status: "OBSERVED", confidence: ads.some((s) => s.confidence === "HIGH") ? "HIGH" : "MEDIUM", agent: "sage", evidence: ads.map((s) => ({ type: "social" as const, id: s.id })), evidenceAt: facts.now.toISOString(), detail: ads.map((s) => `${s.platform}: ${s.adActivity ? "ads running" : `${s.inventoryPostsLast30Days} inventory posts in 30 days`}`).join("; ") });
  else if (facts.social.length) signals.push({ id: "advertising", label: "Currently advertising vehicles", points: 0, max: 15, status: "OBSERVED", confidence: "MEDIUM", agent: "sage", evidence: facts.social.map((s) => ({ type: "social" as const, id: s.id })), evidenceAt: facts.now.toISOString(), detail: "no vehicle advertising seen on the public channels read" });
  else signals.push(unknown("advertising", "Currently advertising vehicles", 15, "sage", "no social channels read yet"));

  // 3. Hiring BDC or internet sales staff (15)
  const hiring = facts.signals.filter((s) => (s.type === "BDC_HIRING" || s.type === "INTERNET_SALES_HIRING") && facts.now.getTime() - s.detectedAt.getTime() < 90 * 86_400_000);
  if (hiring.length) signals.push({ id: "hiring", label: "Hiring BDC or internet sales staff", points: 15, max: 15, status: "OBSERVED", confidence: hiring.some((s) => s.confidence === "HIGH") ? "HIGH" : "MEDIUM", agent: "hunter", evidence: hiring.map((s) => ({ type: "signal" as const, id: s.id })), evidenceAt: hiring[0]!.detectedAt.toISOString(), detail: `${hiring.length} hiring signal(s) in the last 90 days` });
  else signals.push({ id: "hiring", label: "Hiring BDC or internet sales staff", points: 0, max: 15, status: "OBSERVED", confidence: "MEDIUM", agent: "hunter", evidence: [], evidenceAt: null, detail: "no BDC or internet-sales postings found on the careers page" });

  // 4. Verified slow or missed lead follow-up (20): only a controlled test can show this
  const i = facts.interaction;
  if (i) {
    const first = i.responses.length ? Math.min(...i.responses.map((r) => r.responseSeconds)) : null;
    if (first === null && i.closed) signals.push({ id: "follow_up", label: "Verified slow or missed lead follow-up", points: 20, max: 20, status: "OBSERVED", confidence: "HIGH", agent: "charlie", evidence: [{ type: "interaction", id: i.id }], evidenceAt: i.submittedAt.toISOString(), detail: "a controlled inquiry got no reply at all" });
    else if (first !== null && first > SLOW_SECONDS) signals.push({ id: "follow_up", label: "Verified slow or missed lead follow-up", points: 20, max: 20, status: "OBSERVED", confidence: "HIGH", agent: "charlie", evidence: [{ type: "interaction", id: i.id }], evidenceAt: i.submittedAt.toISOString(), detail: `first reply took ${Math.round(first / 60)} minutes` });
    else if (first !== null) signals.push({ id: "follow_up", label: "Verified slow or missed lead follow-up", points: 0, max: 20, status: "OBSERVED", confidence: "HIGH", agent: "charlie", evidence: [{ type: "interaction", id: i.id }], evidenceAt: i.submittedAt.toISOString(), detail: `replied in ${Math.round(first / 60)} minutes` });
    else signals.push(unknown("follow_up", "Verified slow or missed lead follow-up", 20, "charlie", "a test is still being watched for a reply"));
  } else signals.push(unknown("follow_up", "Verified slow or missed lead follow-up", 20, "charlie", "no controlled lead test run yet"));

  // 5. No clear after-hours response process (10)
  const o = facts.observation;
  if (o && o.websiteStatus === "OK") {
    const covered = o.chatPresent || input.smsOffered || input.receptionist === "AI_RECEPTIONIST";
    signals.push({ id: "after_hours", label: "No clear after-hours response process", points: covered ? 0 : 10, max: 10, status: "INFERRED", confidence: "MEDIUM", agent: "nova", evidence: [{ type: "observation", id: o.id }], evidenceAt: o.timestamp.toISOString(), detail: covered ? `${o.chatPresent ? "chat widget" : input.smsOffered ? "text option" : "AI receptionist"} covers after-hours contact` : "no chat widget, no text option and no AI receptionist found" });
  } else signals.push(unknown("after_hours", "No clear after-hours response process", 10, "nova", "website not read yet"));

  // 6. Owner or GM identified (10)
  const named = input.contactTitles.filter((t) => OWNER_TITLE.test(t));
  signals.push(named.length ? { id: "decision_maker", label: "Owner or GM identified", points: 10, max: 10, status: "OBSERVED", confidence: "HIGH", agent: "blaze", evidence: [], evidenceAt: facts.now.toISOString(), detail: `${named.length} decision-maker contact(s) on file with a source` } : { id: "decision_maker", label: "Owner or GM identified", points: 0, max: 10, status: "OBSERVED", confidence: "MEDIUM", agent: "blaze", evidence: [], evidenceAt: null, detail: "no owner or GM contact on file yet" });

  // 7. Confirmed interest in improving follow-up (10): only from a logged conversation
  const readiness = readinessFrom(input.outcomes);
  signals.push(readiness === "CONFIRMED_INTEREST" ? { id: "interest", label: "Confirmed interest in improving CRM follow-up", points: 10, max: 10, status: "OBSERVED", confidence: "HIGH", agent: "echo", evidence: [], evidenceAt: facts.now.toISOString(), detail: "logged by the sales team" } : { id: "interest", label: "Confirmed interest in improving CRM follow-up", points: 0, max: 10, status: input.outcomes.length ? "OBSERVED" : "UNKNOWN", confidence: input.outcomes.length ? "HIGH" : null, agent: "echo", evidence: [], evidenceAt: null, detail: input.outcomes.length ? READINESS_LABEL[readiness].toLowerCase() : "nobody has spoken with this dealership yet" });

  const score = Math.min(100, signals.reduce((a, s) => a + s.points, 0));
  const known = signals.filter((s) => s.status !== "UNKNOWN");
  const high = known.filter((s) => s.confidence === "HIGH").length;
  const confidence: IntentConfidence = known.length >= 6 && high >= 4 ? "HIGH" : known.length >= 4 ? "MEDIUM" : "LOW";
  return { score, band: bandFor(score), readiness, confidence, signals, ruleVersion: INTENT_RULE_VERSION };
}
