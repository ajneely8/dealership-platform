import { createHash } from "node:crypto";
import type { BriefClaim, ScoreReason } from "@/db/schema";
import { PRODUCT_LABEL, ROLE_TARGETS, type EvidenceRef, type Product } from "./constants";
import { formatDuration } from "./response-timing";

export const PRODUCT_DESCRIPTION: Record<Product, string> = {
  SUMMARYBOT: "SummaryBot connects to the dealership's website forms and follows up with each new lead by SMS right after they submit.",
  INVENTORY_OUTREACH: "Inventory Outreach contacts past leads and customers when a vehicle that fits what they wanted comes into stock.",
  SERVICE_BOT: "Service Bot lets customers schedule service by message and sends appropriate maintenance reminders.",
  SOCIAL_AUTOMATION: "Social Media DM Automation answers the questions people send and post on the dealership's social accounts.",
};

/** Fixed wording used when no AI provider is configured (or its output fails the grounding check). */
const TEMPLATE_ANGLE: Record<Product, (problem: string) => string> = {
  SUMMARYBOT: (p) =>
    `The dealership appears to have a gap between a web lead being submitted and a real conversation starting (${p}). SummaryBot would engage those inquiries by SMS right away while the sales team handles the conversations that need a person.`,
  INVENTORY_OUTREACH: (p) =>
    `The evidence points to inventory that past leads are not being told about (${p}). Inventory Outreach would contact previous leads and customers when a matching vehicle arrives, without adding work for the BDC.`,
  SERVICE_BOT: (p) =>
    `Booking service looks harder than it needs to be (${p}). Service Bot would let customers schedule by message and keep maintenance reminders going without tying up advisors.`,
  SOCIAL_AUTOMATION: (p) =>
    `The dealership's social accounts appear to be generating questions that are not getting handled (${p}). Social Media DM Automation would answer those conversations and route real buyers to the team.`,
};

/** Fixed, product-specific call scripts. "[your name]" is left for the caller; the app never invents a person. */
const OPENER: Record<Product, (dealer: string) => string> = {
  SUMMARYBOT: (d) => `Hey, this is [your name] with SideKick. I was looking into how ${d} handles online inquiries and noticed something I wanted to ask you about. Who oversees that process?`,
  INVENTORY_OUTREACH: (d) => `Hey, this is [your name] with SideKick. I was looking at how ${d} lets past customers know when the right vehicle comes in, and had a quick question. Who handles that?`,
  SERVICE_BOT: (d) => `Hey, this is [your name] with SideKick. I was looking at how customers book service with ${d} and noticed something worth a quick question. Who runs the service drive?`,
  SOCIAL_AUTOMATION: (d) => `Hey, this is [your name] with SideKick. I was looking at ${d}'s social pages and the questions people leave there. Who handles those replies?`,
};
const DISCOVERY: Record<Product, string> = {
  SUMMARYBOT: "When someone submits a vehicle inquiry after hours, how does your team make sure it gets followed up on?",
  INVENTORY_OUTREACH: "When a vehicle a past lead asked about comes into stock, how do they hear about it today?",
  SERVICE_BOT: "When someone wants to book service after hours, what happens to that request?",
  SOCIAL_AUTOMATION: "When someone asks about a vehicle in a comment or a DM, who answers, and how fast?",
};

/** Bump when the brief gains fields, so existing briefs are rebuilt once with the new content. */
const BRIEF_FORMAT = 2;

export type BriefInput = {
  dealership: { name: string; inventoryCount: number | null; latestInventoryId: string | null };
  priorityScore: number;
  scores: { product: Product; score: number; reasons: ScoreReason[] }[];
  interaction: {
    id: string;
    submittedAt: Date;
    status: string;
    firstResponseSeconds: number | null;
    responses: { id: string; channel: string; responseSeconds: number; humanOrAutomation: string }[];
  } | null;
  signals: { id: string; type: string; title: string; kind: "OBSERVED" | "INFERENCE"; confidence: "HIGH" | "MEDIUM" | "LOW" }[];
  retestAfter: Date | null;
  hasGroupWithoutOwnership: boolean;
};

export type BuiltBrief = {
  recommendedProduct: Product | null;
  secondaryProduct: Product | null;
  mainProblem: string | null;
  claims: (BriefClaim & { id: string })[];
  templateAngle: string | null;
  coldCallOpener: string | null;
  discoveryQuestion: string | null;
  recommendedRoles: string[];
  nextAction: string;
  inputHash: string;
};

/**
 * Assembles the sales brief from stored records only. Every claim carries the evidence refs it was
 * built from; a claim with no evidence is never emitted. The optional AI step only rewrites the
 * angle text and must cite these claims — it cannot add any.
 */
export function buildBrief(input: BriefInput): BuiltBrief {
  const ranked = [...input.scores].sort((a, b) => b.score - a.score);
  const top = ranked[0] && ranked[0].score > 0 ? ranked[0] : null;
  const second = ranked[1] && ranked[1].score >= 25 ? ranked[1] : null;

  const claims: (BriefClaim & { id: string })[] = [];
  const add = (text: string, kind: BriefClaim["kind"], confidence: BriefClaim["confidence"], evidence: EvidenceRef[]) => {
    if (evidence.length === 0) return; // no evidence, no claim
    claims.push({ id: `c${claims.length + 1}`, text, kind, confidence, evidence });
  };

  if (input.interaction) {
    const i = input.interaction;
    const ref: EvidenceRef[] = [{ type: "interaction", id: i.id }];
    add(`Lead submitted ${i.submittedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`, "OBSERVED", "HIGH", ref);
    if (i.firstResponseSeconds !== null) add(`First response after ${formatDuration(i.firstResponseSeconds)}`, "OBSERVED", "HIGH", ref);
    for (const channel of ["SMS", "EMAIL", "PHONE"]) {
      const first = i.responses.filter((r) => r.channel === channel).sort((a, b) => a.responseSeconds - b.responseSeconds)[0];
      if (first) {
        const who = first.humanOrAutomation === "HUMAN" ? "human " : first.humanOrAutomation === "AUTOMATION" ? "automated " : "";
        add(`First ${who}${channel === "PHONE" ? "phone call" : channel === "SMS" ? "SMS" : "email"} after ${formatDuration(first.responseSeconds)}`, "OBSERVED", "HIGH", [
          { type: "response", id: first.id },
        ]);
      }
    }
  }
  if (top) for (const r of top.reasons) add(r.label, r.kind, r.confidence, r.evidence);
  if (second) for (const r of second.reasons.slice(0, 3)) add(`${PRODUCT_LABEL[second.product]}: ${r.label}`, r.kind, r.confidence, r.evidence);
  // Skip the plain inventory line when a "large inventory" reason already states the count.
  const inventoryStated = [top, second].some((s) => s?.reasons.some((r) => r.ruleId === "io.large_inventory"));
  if (!inventoryStated && input.dealership.inventoryCount !== null && input.dealership.latestInventoryId) {
    add(`Inventory: ${input.dealership.inventoryCount} vehicles`, "OBSERVED", "MEDIUM", [{ type: "inventory", id: input.dealership.latestInventoryId }]);
  }
  for (const s of input.signals.slice(0, 5)) add(`Signal: ${s.title}`, s.kind, s.confidence, [{ type: "signal", id: s.id }]);

  // De-duplicate by text: a reason and a fact line can say the same thing.
  const seen = new Set<string>();
  const unique = claims.filter((c) => (seen.has(c.text) ? false : (seen.add(c.text), true))).map((c, idx) => ({ ...c, id: `c${idx + 1}` }));

  const strongest = top ? [...top.reasons].sort((a, b) => b.points - a.points)[0] : undefined;
  const mainProblem = strongest?.label ?? null;

  let nextAction: string;
  if (input.interaction?.status === "MONITORING") nextAction = "Wait for response timer";
  else if (!top) nextAction = "Review website research";
  else if (input.hasGroupWithoutOwnership) nextAction = "Research group ownership";
  else nextAction = `Contact ${ROLE_TARGETS[top.product][0]}`;
  if (input.retestAfter && input.interaction?.status !== "MONITORING") nextAction += ` · Do not retest until ${input.retestAfter.toISOString().slice(0, 10)}`;

  const inputHash = createHash("sha256")
    .update(JSON.stringify([BRIEF_FORMAT, input.priorityScore, top?.product, second?.product, unique.map((c) => [c.text, c.evidence])]))
    .digest("hex");

  return {
    recommendedProduct: top?.product ?? null,
    secondaryProduct: second?.product ?? null,
    mainProblem,
    claims: unique,
    templateAngle: top && mainProblem ? TEMPLATE_ANGLE[top.product](mainProblem.charAt(0).toLowerCase() + mainProblem.slice(1)) : null,
    coldCallOpener: top ? OPENER[top.product](input.dealership.name) : null,
    discoveryQuestion: top ? DISCOVERY[top.product] : null,
    recommendedRoles: top ? ROLE_TARGETS[top.product] : [],
    nextAction,
    inputHash,
  };
}
