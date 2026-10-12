import type { PriorityBreakdown, ScoreReason, ServiceDetails } from "@/db/schema";
import { GROWTH_SIGNAL_TYPES, PRODUCTS, PRODUCT_LABEL, type Channel, type Confidence, type EvidenceRef, type FindingKind, type Product, type ResponseClassification, type SignalType } from "../constants";
import { RULES, type ScoringConfig } from "./config";

/**
 * Everything scoring is allowed to look at. Built from stored records by facts.ts; the engine
 * itself never touches the database or an LLM, so the same facts always give the same score.
 */
export type ScoringFacts = {
  now: Date;
  observation: {
    id: string;
    timestamp: Date;
    websiteStatus: string;
    chatPresent: boolean;
    chatWorking: boolean | null;
    chatQuality: number | null;
    leadFormCount: number;
    inventoryPagePresent: boolean;
    inventoryAlertsPresent: boolean | null;
    servicePagePresent: boolean;
    serviceSchedulerPresent: boolean;
    service: ServiceDetails | null;
  } | null;
  /** Newest first. */
  inventory: { id: string; capturedAt: Date; total: number | null; vdpUrls: string[]; confidence: Confidence }[];
  /** Most recent submitted controlled interaction, if any. */
  interaction: {
    id: string;
    submittedAt: Date;
    /** True once the monitoring window has closed. */
    closed: boolean;
    responses: {
      id: string;
      channel: Channel;
      responseSeconds: number;
      classification: ResponseClassification;
      personalizationScore: number | null;
      vehicleReferenced: boolean | null;
    }[];
  } | null;
  signals: { id: string; type: SignalType; detectedAt: Date; confidence: Confidence; kind: FindingKind }[];
  /** Latest observation per platform. */
  social: {
    id: string;
    platform: string;
    postsLast30Days: number | null;
    inventoryPostsLast30Days: number | null;
    customerQuestions: number | null;
    unansweredQuestions: number | null;
    adActivity: boolean | null;
    confidence: Confidence;
  }[];
  /** Rooftops this account represents: max(group.storeCount, rooftops on file). 1 when ungrouped. */
  groupRooftops: number;
};

type Hit = { kind: FindingKind; confidence: Confidence; evidence: EvidenceRef[]; detail?: string };
type RuleFn = (f: ScoringFacts, c: ScoringConfig) => Hit | null;

const MIN = 60;
const HOUR = 3600;

const elapsed = (f: ScoringFacts): number => (f.interaction ? (f.now.getTime() - f.interaction.submittedAt.getTime()) / 1000 : 0);
const iref = (f: ScoringFacts): EvidenceRef[] => (f.interaction ? [{ type: "interaction", id: f.interaction.id }] : []);
const oref = (f: ScoringFacts): EvidenceRef[] => (f.observation ? [{ type: "observation", id: f.observation.id }] : []);

function recentSignals(f: ScoringFacts, c: ScoringConfig, types: SignalType[]) {
  const cutoff = f.now.getTime() - c.thresholds.signalRecencyDays * 86_400_000;
  return f.signals.filter((s) => types.includes(s.type) && s.detectedAt.getTime() >= cutoff);
}

function signalRule(types: SignalType[]): RuleFn {
  return (f, c) => {
    const hits = recentSignals(f, c, types);
    if (hits.length === 0) return null;
    const best: Confidence = hits.some((h) => h.confidence === "HIGH") ? "HIGH" : hits.some((h) => h.confidence === "MEDIUM") ? "MEDIUM" : "LOW";
    return {
      kind: hits.every((h) => h.kind === "INFERENCE") ? "INFERENCE" : "OBSERVED",
      confidence: best,
      evidence: hits.map((h) => ({ type: "signal" as const, id: h.id })),
    };
  };
}

const sum = (values: (number | null)[]): number | null => {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
};

function socialRule(pick: (s: ScoringFacts["social"][number]) => number | null, threshold: (c: ScoringConfig) => number): RuleFn {
  return (f, c) => {
    const total = sum(f.social.map(pick));
    if (total === null || total < threshold(c)) return null;
    const used = f.social.filter((s) => pick(s) !== null);
    return {
      kind: "OBSERVED",
      confidence: used.some((s) => s.confidence === "HIGH") ? "HIGH" : "MEDIUM",
      evidence: used.map((s) => ({ type: "social" as const, id: s.id })),
      detail: `${total}`,
    };
  };
}

/** Share of listings that changed between the two newest snapshots, as a percentage. Null when not measurable. */
export function inventoryMovementPct(inventory: ScoringFacts["inventory"]): number | null {
  const [latest, previous] = inventory;
  if (!latest || !previous) return null;
  // Snapshots closer than 2 days apart say nothing about turnover.
  if (latest.capturedAt.getTime() - previous.capturedAt.getTime() < 2 * 86_400_000) return null;
  if (latest.vdpUrls.length >= 10 && previous.vdpUrls.length >= 10) {
    const now = new Set(latest.vdpUrls);
    const gone = previous.vdpUrls.filter((u) => !now.has(u)).length;
    return (gone / previous.vdpUrls.length) * 100;
  }
  if (latest.total !== null && previous.total !== null && previous.total > 0) {
    return (Math.abs(latest.total - previous.total) / previous.total) * 100;
  }
  return null;
}

const RULE_LOGIC: Record<string, RuleFn> = {
  // ---- SummaryBot ---------------------------------------------------------
  "sb.no_sms": (f) => {
    if (!f.interaction) return null;
    const smsInHour = f.interaction.responses.some((r) => r.channel === "SMS" && r.responseSeconds <= HOUR);
    if (smsInHour || elapsed(f) < HOUR) return null; // not yet knowable inside the first hour
    return { kind: "OBSERVED", confidence: "HIGH", evidence: iref(f) };
  },
  "sb.slow_response": (f) => {
    if (!f.interaction) return null;
    const first = Math.min(...f.interaction.responses.map((r) => r.responseSeconds));
    if (Number.isFinite(first)) {
      return first > 15 * MIN ? { kind: "OBSERVED", confidence: "HIGH", evidence: iref(f), detail: `${Math.round(first / 60)} min` } : null;
    }
    return elapsed(f) > 15 * MIN ? { kind: "OBSERVED", confidence: "HIGH", evidence: iref(f) } : null;
  },
  "sb.no_response_1h": (f) => {
    if (!f.interaction || elapsed(f) < HOUR) return null;
    return f.interaction.responses.some((r) => r.responseSeconds <= HOUR) ? null : { kind: "OBSERVED", confidence: "HIGH", evidence: iref(f) };
  },
  "sb.generic_email": (f) => {
    if (!f.interaction) return null;
    const generic = f.interaction.responses.filter(
      (r) =>
        r.channel === "EMAIL" &&
        (r.classification === "AUTO_CONFIRMATION" || r.classification === "AUTOMATED_FOLLOW_UP") &&
        r.vehicleReferenced !== true &&
        (r.personalizationScore === null || r.personalizationScore < 40),
    );
    if (generic.length === 0) return null;
    // Whether an email is "generic" is a judgement on its content, so it is recorded as an inference.
    return { kind: "INFERENCE", confidence: "MEDIUM", evidence: generic.map((r) => ({ type: "response" as const, id: r.id })) };
  },
  "sb.chat_failed": (f) => {
    const o = f.observation;
    if (!o || !o.chatPresent) return null;
    if (o.chatWorking === false) return { kind: "OBSERVED", confidence: "HIGH", evidence: oref(f) };
    if (o.chatQuality !== null && o.chatQuality < 40) return { kind: "INFERENCE", confidence: "MEDIUM", evidence: oref(f) };
    return null;
  },
  "sb.no_follow_up": (f) => {
    if (!f.interaction) return null;
    // Only meaningful once the dealership has had 72 hours (or the monitoring window closed).
    if (!f.interaction.closed && elapsed(f) < 72 * HOUR) return null;
    return f.interaction.responses.length <= 1 ? { kind: "OBSERVED", confidence: "HIGH", evidence: iref(f) } : null;
  },
  "sb.no_chatbot": (f) => {
    const o = f.observation;
    if (!o || o.websiteStatus !== "OK" || o.chatPresent) return null;
    return { kind: "OBSERVED", confidence: "HIGH", evidence: oref(f) };
  },
  "sb.no_lead_form": (f) => {
    const o = f.observation;
    if (!o || o.websiteStatus !== "OK" || o.leadFormCount > 0) return null;
    // We only looked at the pages we scanned, so absence is medium confidence.
    return { kind: "OBSERVED", confidence: "MEDIUM", evidence: oref(f) };
  },
  "sb.growth_hiring": signalRule([...GROWTH_SIGNAL_TYPES]),

  // ---- Inventory Outreach -----------------------------------------------
  "io.large_inventory": (f, c) => {
    const latest = f.inventory[0];
    if (!latest || latest.total === null || latest.total < c.thresholds.largeInventory) return null;
    return { kind: "OBSERVED", confidence: latest.confidence, evidence: [{ type: "inventory", id: latest.id }], detail: `${latest.total} vehicles` };
  },
  "io.high_movement": (f, c) => {
    const pct = inventoryMovementPct(f.inventory);
    if (pct === null || pct < c.thresholds.inventoryMovementPct) return null;
    return {
      kind: "OBSERVED",
      confidence: "MEDIUM",
      evidence: f.inventory.slice(0, 2).map((s) => ({ type: "inventory" as const, id: s.id })),
      detail: `${Math.round(pct)}% changed`,
    };
  },
  "io.no_alerts": (f) => {
    const o = f.observation;
    if (!o || !o.inventoryPagePresent || o.inventoryAlertsPresent !== false) return null;
    // We only looked at the pages we scanned, so absence is medium confidence at best.
    return { kind: "OBSERVED", confidence: "MEDIUM", evidence: oref(f) };
  },
  "io.bdc_hiring": signalRule(["BDC_HIRING"]),
  "io.internet_sales_hiring": signalRule(["INTERNET_SALES_HIRING"]),
  "io.crm_hiring": signalRule(["CRM_HIRING", "SALES_HIRING"]),
  "io.inventory_ads": signalRule(["ADVERTISING_ACTIVITY"]),

  // ---- Service Bot --------------------------------------------------------
  "sv.poor_scheduler": (f, c) => {
    const o = f.observation;
    const s = o?.service;
    if (!o || !o.servicePagePresent || !s) return null;
    const friction =
      s.schedulerMode === "NONE" ||
      s.schedulerMode === "FORM_ONLY" ||
      s.phoneOnly ||
      (s.schedulerFieldCount !== null && s.schedulerFieldCount >= c.thresholds.schedulerFieldCount);
    if (!friction) return null;
    return { kind: "OBSERVED", confidence: s.schedulerMode === "NONE" || s.phoneOnly ? "MEDIUM" : "HIGH", evidence: oref(f), detail: s.frictionNotes[0] };
  },
  "sv.no_service_chat": (f) => {
    const o = f.observation;
    if (!o || !o.servicePagePresent || !o.service || o.service.chatOnServicePage) return null;
    return { kind: "OBSERVED", confidence: "HIGH", evidence: oref(f) };
  },
  "sv.no_sms": (f) => {
    const o = f.observation;
    if (!o || !o.servicePagePresent || !o.service || o.service.smsOptionVisible) return null;
    return { kind: "OBSERVED", confidence: "MEDIUM", evidence: oref(f) };
  },
  "sv.complaints": signalRule(["SERVICE_SCHEDULING_COMPLAINTS"]),
  "sv.service_hiring": signalRule(["SERVICE_HIRING"]),
  "sv.large_service": signalRule(["LARGE_SERVICE_OPERATION"]),

  // ---- Social Automation --------------------------------------------------
  "so.high_activity": socialRule((s) => s.postsLast30Days, (c) => c.thresholds.socialPostsPerMonth),
  "so.inventory_promoted": socialRule((s) => s.inventoryPostsLast30Days, (c) => c.thresholds.socialInventoryPostsPerMonth),
  "so.customer_questions": socialRule((s) => s.customerQuestions, (c) => c.thresholds.socialCustomerQuestions),
  "so.unanswered": socialRule((s) => s.unansweredQuestions, (c) => c.thresholds.socialUnansweredQuestions),
  "so.marketing_hiring": signalRule(["MARKETING_HIRING", "SOCIAL_MEDIA_HIRING"]),
  "so.ads": (f) => {
    const ads = f.social.filter((s) => s.adActivity === true);
    return ads.length ? { kind: "OBSERVED", confidence: "MEDIUM", evidence: ads.map((s) => ({ type: "social" as const, id: s.id })) } : null;
  },
};

export type ProductScore = { product: Product; score: number; reasons: ScoreReason[] };

/** Deterministic product scoring. Sum of the weights of every rule that fires, clamped to 0–100. */
export function scoreProducts(facts: ScoringFacts, config: ScoringConfig): Record<Product, ProductScore> {
  const out = Object.fromEntries(PRODUCTS.map((p) => [p, { product: p, score: 0, reasons: [] as ScoreReason[] }])) as Record<Product, ProductScore>;
  for (const rule of RULES) {
    const points = config.weights[rule.id] ?? rule.defaultPoints;
    if (points <= 0) continue; // a weight of 0 switches the rule off
    const logic = RULE_LOGIC[rule.id];
    if (!logic) throw new Error(`Scoring rule ${rule.id} has no implementation`);
    const hit = logic(facts, config);
    if (!hit) continue;
    out[rule.product].reasons.push({
      ruleId: rule.id,
      points,
      label: hit.detail ? `${rule.label} (${hit.detail})` : rule.label,
      kind: hit.kind,
      confidence: hit.confidence,
      evidence: hit.evidence,
    });
  }
  for (const p of PRODUCTS) {
    out[p].score = Math.min(100, out[p].reasons.reduce((a, r) => a + r.points, 0));
  }
  return out;
}

const CONFIDENCE_WEIGHT: Record<Confidence, number> = { HIGH: 1, MEDIUM: 0.6, LOW: 0.3 };
const BUYING_SIGNALS: SignalType[] = [
  "BDC_HIRING",
  "SALES_HIRING",
  "INTERNET_SALES_HIRING",
  "SERVICE_HIRING",
  "MARKETING_HIRING",
  "SOCIAL_MEDIA_HIRING",
  "CRM_HIRING",
  "AI_HIRING",
  "MANAGEMENT_CHANGE",
  "OWNERSHIP_CHANGE",
  "NEW_LOCATION",
  "EXPANSION",
  "ACQUISITION",
  "ADVERTISING_ACTIVITY",
];

export function rankProducts(scores: Record<Product, ProductScore>): ProductScore[] {
  // Stable tie-break on the fixed product order so results never flip between runs.
  return PRODUCTS.map((p) => scores[p]).sort((a, b) => b.score - a.score || PRODUCTS.indexOf(a.product) - PRODUCTS.indexOf(b.product));
}

/**
 * Overall priority, 0–100:
 *   product opportunity (50) + buying/budget signals (15) + evidence confidence (15)
 *   + group value (10) + recency (10)
 * Each component is returned with its inputs so the dashboard can explain the number.
 */
export function computePriority(facts: ScoringFacts, scores: Record<Product, ProductScore>, config: ScoringConfig): PriorityBreakdown {
  const ranked = rankProducts(scores);
  const best = ranked[0]!;
  const second = ranked[1]!;

  const product = Math.round(best.score * 0.4 + second.score * 0.1);

  const signalTypes = new Set(recentSignals(facts, config, BUYING_SIGNALS).map((s) => s.type));
  const signalPoints = Math.min(15, signalTypes.size * 5);

  // Confidence: points-weighted average of how solid the top product's reasons are.
  const totalPts = best.reasons.reduce((a, r) => a + r.points, 0);
  const solid = best.reasons.reduce((a, r) => a + r.points * CONFIDENCE_WEIGHT[r.confidence] * (r.kind === "INFERENCE" ? 0.7 : 1), 0);
  const confidenceRatio = totalPts > 0 ? solid / totalPts : 0;
  const confidence = Math.round(confidenceRatio * 15);

  const n = facts.groupRooftops;
  const group = n >= 10 ? 10 : n >= 5 ? 7 : n >= 2 ? 4 : 0;

  const stamps = [facts.observation?.timestamp, facts.interaction?.submittedAt, facts.inventory[0]?.capturedAt, ...facts.signals.map((s) => s.detectedAt)]
    .filter((d): d is Date => d instanceof Date)
    .map((d) => d.getTime());
  const ageDays = stamps.length ? (facts.now.getTime() - Math.max(...stamps)) / 86_400_000 : Infinity;
  const recency = ageDays <= 7 ? 10 : ageDays <= 14 ? 8 : ageDays <= 30 ? 5 : ageDays <= 60 ? 2 : 0;

  // With no product opportunity there is nothing to prioritise, whatever the other components say.
  const total = best.score === 0 ? 0 : Math.min(100, product + signalPoints + confidence + group + recency);

  return {
    total,
    components: [
      {
        key: "product",
        label: "Product opportunity",
        points: product,
        max: 50,
        detail: `${PRODUCT_LABEL[best.product]} ${best.score} × 0.4 + ${PRODUCT_LABEL[second.product]} ${second.score} × 0.1`,
      },
      {
        key: "signals",
        label: "Buying / budget signals",
        points: signalPoints,
        max: 15,
        detail: signalTypes.size ? `${signalTypes.size} signal type(s) in the last ${config.thresholds.signalRecencyDays} days` : "No recent signals",
      },
      {
        key: "confidence",
        label: "Evidence confidence",
        points: confidence,
        max: 15,
        detail: totalPts > 0 ? `${Math.round(confidenceRatio * 100)}% of top-product points rest on high-confidence observations` : "No evidence yet",
      },
      { key: "group", label: "Group value", points: group, max: 10, detail: n > 1 ? `${n} rooftops in group` : "Single rooftop" },
      {
        key: "recency",
        label: "Recency",
        points: recency,
        max: 10,
        detail: Number.isFinite(ageDays) ? `Newest evidence is ${Math.floor(ageDays)} day(s) old` : "No evidence yet",
      },
    ],
  };
}
