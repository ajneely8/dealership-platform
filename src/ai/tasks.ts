import { z } from "zod";
import { RESPONSE_CLASSIFICATIONS, SENDER_KINDS } from "@/domain/constants";
import { runAI, type AIBudget } from "./provider";

// ---------------------------------------------------------------------------
// Response classification
// ---------------------------------------------------------------------------

const responseJudgement = z.object({
  classification: z.enum(RESPONSE_CLASSIFICATIONS),
  humanOrAutomation: z.enum(SENDER_KINDS),
  personalizationScore: z.number().int().min(0).max(100),
  questionAnswered: z.boolean(),
  vehicleReferenced: z.boolean(),
  callToAction: z.string().max(120).nullable(),
  qualityScore: z.number().int().min(0).max(100),
});
export type ResponseJudgement = z.infer<typeof responseJudgement>;

/** Longest dealership reply we send for classification. Longer messages are skipped, not truncated. */
export const MAX_CLASSIFIABLE_CHARS = 6000;

export function judgeResponse(
  input: { channel: string; responseSeconds: number; sender: string | null; inquiry: string | null; vehicle: string | null; message: string },
  budget: AIBudget,
) {
  return runAI(
    {
      task: "classify-response.v1",
      system: [
        "You assess one reply a car dealership sent to a website inquiry. Judge only the reply text you are given.",
        "classification: AUTO_CONFIRMATION (instant receipt/acknowledgement), AUTOMATED_FOLLOW_UP (templated sequence message), HUMAN_FOLLOW_UP (written by a person), MARKETING (promotion unrelated to the inquiry), UNRELATED, or UNKNOWN when you cannot tell.",
        "personalizationScore: 0 = fully generic template, 100 = clearly written for this specific inquiry.",
        "questionAnswered: true only if the reply actually answers the inquiry's question.",
        "vehicleReferenced: true only if the reply names the specific vehicle from the inquiry.",
        "callToAction: the next step the reply asks for, in a few words, or null.",
        "qualityScore: 0-100 for how well this reply would move a real shopper forward.",
        "Use UNKNOWN rather than guessing. Do not infer anything about the dealership beyond this message.",
      ].join("\n"),
      input,
      schema: responseJudgement,
      effort: "low",
      maxTokens: 4000,
    },
    budget,
  );
}

// ---------------------------------------------------------------------------
// Sales angle
// ---------------------------------------------------------------------------

const angleOutput = z.object({
  mainProblem: z.string().max(160),
  salesAngle: z.string().max(700),
  /** One or two natural sentences a caller can say first; keep "[your name]" as a placeholder. */
  coldCallOpener: z.string().max(400),
  /** One question that confirms whether the problem exists. */
  discoveryQuestion: z.string().max(300),
  citedClaimIds: z.array(z.string()).min(1),
});
export type AngleOutput = z.infer<typeof angleOutput>;

export function writeSalesAngle(
  input: {
    dealership: string;
    recommendedProduct: string;
    productDescription: string;
    secondaryProduct: string | null;
    /** The only facts the model may use. Each has an id it must cite. */
    claims: { id: string; kind: string; confidence: string; text: string }[];
  },
  budget: AIBudget,
) {
  return runAI(
    {
      task: "sales-angle.v1",
      system: [
        "You write a short sales angle for a salesperson about to contact a car dealership.",
        "Use ONLY the facts in `claims`. Do not add numbers, times, names, vendors or outcomes that are not in a claim. Do not promise results or quote performance figures.",
        "Claims marked INFERENCE are possibilities, not facts — phrase them with 'appears' or 'may'.",
        "mainProblem: one plain sentence naming the single biggest gap the evidence shows.",
        "salesAngle: 2-3 plain sentences. Lead with the dealership's problem, then how the recommended product addresses it. No jargon, no hype.",
        "coldCallOpener: 1-2 spoken sentences to open a cold call, curiosity-driven, no pitch, ending with who to ask for. Start with 'Hey, this is [your name] with SarvX' and keep that placeholder.",
        "discoveryQuestion: one plain question that confirms whether the problem exists, aimed at the dealership's own process.",
        "citedClaimIds: the id of every claim you relied on. Every statement of fact must trace to one of these.",
      ].join("\n"),
      input,
      schema: angleOutput,
      effort: "medium",
      maxTokens: 6000,
    },
    budget,
  );
}

/**
 * Guard against invented specifics: every number in the generated text must also appear in a cited
 * claim. If the model slipped in a figure of its own, the caller discards the text and uses the template.
 */
export function angleIsGrounded(output: AngleOutput, claims: readonly { id: string; text: string }[]): { ok: boolean; reason?: string } {
  const byId = new Map(claims.map((c) => [c.id, c.text]));
  const unknown = output.citedClaimIds.filter((id) => !byId.has(id));
  if (unknown.length) return { ok: false, reason: `Cited unknown claim id(s): ${unknown.join(", ")}` };
  const allowed = new Set(output.citedClaimIds.flatMap((id) => (byId.get(id) ?? "").match(/\d[\d,.:]*/g) ?? []).map((n) => n.replace(/[,.:]$/, "")));
  for (const text of [output.salesAngle, output.mainProblem, output.coldCallOpener, output.discoveryQuestion]) {
    for (const n of text.match(/\d[\d,.:]*/g) ?? []) {
      if (!allowed.has(n.replace(/[,.:]$/, ""))) return { ok: false, reason: `Number "${n}" is not in any cited claim` };
    }
  }
  return { ok: true };
}
