import { MILESTONES, type Channel, type MilestoneKey, type ResponseClassification, type SenderKind } from "./constants";

/** Seconds between submission and a response. Never negative: clock skew is clamped to 0. */
export function responseSeconds(submittedAt: Date, receivedAt: Date): number {
  return Math.max(0, Math.round((receivedAt.getTime() - submittedAt.getTime()) / 1000));
}

export function firstResponseSeconds(responses: readonly { responseSeconds: number }[]): number | null {
  if (responses.length === 0) return null;
  return Math.min(...responses.map((r) => r.responseSeconds));
}

/**
 * For every milestone that has already elapsed, records whether any response had arrived by then.
 * Milestones still in the future are left out, so "no response" is never claimed early.
 */
export function evaluateMilestones(
  submittedAt: Date,
  responses: readonly { responseSeconds: number }[],
  now: Date,
): Partial<Record<MilestoneKey, boolean>> {
  const elapsed = (now.getTime() - submittedAt.getTime()) / 1000;
  const first = firstResponseSeconds(responses);
  const out: Partial<Record<MilestoneKey, boolean>> = {};
  for (const m of MILESTONES) {
    if (elapsed >= m.seconds) out[m.key] = first !== null && first <= m.seconds;
    else if (first !== null && first <= m.seconds) out[m.key] = true; // already satisfied; no need to wait
  }
  return out;
}

/** The next milestone that still needs a check, as an absolute time. Null when all have passed. */
export function nextMilestoneAt(submittedAt: Date, now: Date): Date | null {
  for (const m of MILESTONES) {
    const at = submittedAt.getTime() + m.seconds * 1000;
    if (at > now.getTime()) return new Date(at);
  }
  return null;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h ${rem}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export type RuleClassification = {
  classification: ResponseClassification;
  humanOrAutomation: SenderKind;
  vehicleReferenced: boolean | null;
  callToAction: string | null;
};

const AUTO_PATTERNS = [
  /thank you for (your|contacting|reaching)/i,
  /we('ve| have) received your/i,
  /this is an automated/i,
  /do not reply/i,
  /a (member|representative) of our team will/i,
  /your (request|inquiry|message) has been (received|submitted)/i,
  /reply stop/i,
  /msg ?& ?data rates/i,
];
const NOREPLY_SENDER = /no-?reply|donotreply|notifications?@|mailer-daemon/i;
const CTA_PATTERNS: [RegExp, string][] = [
  [/\b(schedule|book|set up)\b.{0,40}\b(appointment|visit|time|test drive)\b/i, "Schedule a visit"],
  [/\bcall (me|us)\b|\bgive (me|us) a call\b/i, "Call"],
  [/\bwhen (can|could|would) you\b|\bwhat time works\b/i, "Asks for a time"],
  [/\bclick (here|the link)\b|https?:\/\//i, "Link"],
  [/\breply\b|\btext (me|us) back\b|\blet (me|us) know\b/i, "Reply"],
];

/**
 * Cheap, deterministic first-pass classification used when a response is recorded.
 * It only asserts what text patterns can support; anything judgement-based (personalisation,
 * whether the question was answered, quality) is left null for the AI pass or an operator.
 */
export function classifyResponseByRule(input: {
  channel: Channel;
  message: string | null;
  sender: string | null;
  responseSeconds: number;
  vehicleText?: string | null;
}): RuleClassification {
  const text = input.message ?? "";
  const cta = CTA_PATTERNS.find(([re]) => re.test(text))?.[1] ?? null;
  const vehicleReferenced = input.vehicleText && text ? text.toLowerCase().includes(input.vehicleText.toLowerCase()) : null;

  if (input.channel === "PHONE") {
    // A phone call event has no body; a live call is treated as human unless the provider says otherwise.
    return { classification: "HUMAN_FOLLOW_UP", humanOrAutomation: "HUMAN", vehicleReferenced: null, callToAction: null };
  }
  const looksAutomated = AUTO_PATTERNS.some((re) => re.test(text)) || (input.sender ? NOREPLY_SENDER.test(input.sender) : false);
  if (looksAutomated) {
    return {
      classification: input.responseSeconds <= 300 ? "AUTO_CONFIRMATION" : "AUTOMATED_FOLLOW_UP",
      humanOrAutomation: "AUTOMATION",
      vehicleReferenced,
      callToAction: cta,
    };
  }
  // Anything inside 20 seconds is faster than a person can read and type.
  if (input.responseSeconds <= 20) {
    return { classification: "AUTO_CONFIRMATION", humanOrAutomation: "AUTOMATION", vehicleReferenced, callToAction: cta };
  }
  return { classification: "UNKNOWN", humanOrAutomation: "UNKNOWN", vehicleReferenced, callToAction: cta };
}
