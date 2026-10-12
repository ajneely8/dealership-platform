import { and, desc, eq, gte, isNotNull, isNull } from "drizzle-orm";
import { judgeResponse, angleIsGrounded, MAX_CLASSIFIABLE_CHARS, writeSalesAngle } from "@/ai/tasks";
import { AIBudget, AIBudgetError, AIUnavailableError, resolveProvider } from "@/ai/provider";
import { db } from "@/db";
import { dealerGroups, dealerships, inventorySnapshots, responses, salesBriefs, scores, signals, testInteractions } from "@/db/schema";
import { buildBrief, PRODUCT_DESCRIPTION } from "@/domain/brief";
import { PRODUCT_LABEL } from "@/domain/constants";
import { runScoring } from "@/domain/scoring/run";
import { logger } from "@/lib/logger";
import { getSettings } from "@/lib/settings";
import { emit } from "@/lib/agent-events";

/**
 * Sales Intelligence worker.
 *  1. If an AI provider is configured, refine the rule-based classification of new responses.
 *  2. Re-score if that changed anything.
 *  3. Build the brief from stored evidence; optionally let the AI rewrite the angle (grounded check applied).
 * With no provider, steps 1 and the AI half of 3 are skipped and the brief uses the template angle.
 */
export async function runSalesIntel(dealershipId: string): Promise<string> {
  const settings = await getSettings();
  const budget = new AIBudget(settings.maxAIRequestsPerJob, settings.maxAITokensPerJob);
  const provider = await resolveProvider();
  const notes: string[] = [];

  const [dealer] = await db().select().from(dealerships).where(eq(dealerships.id, dealershipId)).limit(1);
  if (!dealer) return "SKIPPED: dealership not found";

  const [interaction] = await db()
    .select()
    .from(testInteractions)
    .where(and(eq(testInteractions.dealershipId, dealershipId), eq(testInteractions.testType, "FORM"), isNotNull(testInteractions.submittedAt)))
    .orderBy(desc(testInteractions.submittedAt))
    .limit(1);

  // --- 1. AI classification of responses the rules could not settle -----------
  if (provider && interaction) {
    const pending = await db()
      .select()
      .from(responses)
      .where(and(eq(responses.interactionId, interaction.id), eq(responses.classifiedBy, "RULE"), isNull(responses.qualityScore), isNotNull(responses.message)));
    let refined = 0;
    for (const r of pending) {
      if (!r.message || r.channel === "PHONE") continue;
      if (r.message.length > MAX_CLASSIFIABLE_CHARS) {
        notes.push(`response ${r.id.slice(0, 8)} too long to classify`);
        continue;
      }
      try {
        const { data } = await judgeResponse(
          { channel: r.channel, responseSeconds: r.responseSeconds, sender: r.sender, inquiry: interaction.message, vehicle: interaction.vehicleId, message: r.message },
          budget,
        );
        await db().update(responses).set({ ...data, classifiedBy: "AI" }).where(eq(responses.id, r.id));
        refined += 1;
      } catch (err) {
        if (err instanceof AIBudgetError || err instanceof AIUnavailableError) {
          notes.push(err.message);
          break;
        }
        // A failed classification leaves the rule-based result in place; it is not fatal.
        logger.warn({ err: (err as Error).message, responseId: r.id }, "AI response classification failed");
        notes.push("AI classification failed for one response");
      }
    }
    if (refined > 0) {
      await runScoring(dealershipId, "system:sales-intel");
      notes.push(`${refined} response(s) classified by AI`);
    }
  }

  // --- 2. Gather evidence for the brief ---------------------------------------
  const [fresh] = await db().select().from(dealerships).where(eq(dealerships.id, dealershipId)).limit(1);
  const scoreRows = await db().select().from(scores).where(eq(scores.dealershipId, dealershipId));
  const interactionResponses = interaction ? await db().select().from(responses).where(eq(responses.interactionId, interaction.id)) : [];
  const [latestInventory] = await db()
    .select({ id: inventorySnapshots.id })
    .from(inventorySnapshots)
    .where(and(eq(inventorySnapshots.dealershipId, dealershipId), isNotNull(inventorySnapshots.total)))
    .orderBy(desc(inventorySnapshots.capturedAt))
    .limit(1);
  const recentSignals = await db()
    .select()
    .from(signals)
    .where(and(eq(signals.dealershipId, dealershipId), gte(signals.detectedAt, new Date(Date.now() - settings.scoringThresholds.signalRecencyDays * 86_400_000))))
    .orderBy(desc(signals.detectedAt));
  const [group] = dealer.groupId ? await db().select().from(dealerGroups).where(eq(dealerGroups.id, dealer.groupId)).limit(1) : [];

  const cooldownMs = Math.max(30, settings.interactionCooldownDays) * 86_400_000;
  const retestAfter = interaction?.submittedAt ? new Date(interaction.submittedAt.getTime() + cooldownMs) : null;

  const built = buildBrief({
    dealership: { name: dealer.name, inventoryCount: fresh?.inventoryCount ?? null, latestInventoryId: latestInventory?.id ?? null },
    priorityScore: fresh?.priorityScore ?? 0,
    scores: scoreRows.map((s) => ({ product: s.product, score: s.score, reasons: s.reasons })),
    interaction:
      interaction && interaction.submittedAt
        ? {
            id: interaction.id,
            submittedAt: interaction.submittedAt,
            status: interaction.status,
            firstResponseSeconds: interaction.firstResponseSeconds,
            responses: interactionResponses.map((r) => ({ id: r.id, channel: r.channel, responseSeconds: r.responseSeconds, humanOrAutomation: r.humanOrAutomation })),
          }
        : null,
    signals: recentSignals.map((s) => ({ id: s.id, type: s.type, title: s.title, kind: s.kind, confidence: s.confidence })),
    retestAfter: retestAfter && retestAfter.getTime() > Date.now() ? retestAfter : null,
    hasGroupWithoutOwnership: !!group && !group.ownershipInformation,
  });

  // Unchanged evidence: keep the existing brief (and spend nothing).
  const [previous] = await db().select().from(salesBriefs).where(eq(salesBriefs.dealershipId, dealershipId)).orderBy(desc(salesBriefs.generatedAt)).limit(1);
  if (previous && previous.inputHash === built.inputHash) {
    await emit("Brief already current for this evidence", { status: "INFO" });
    return `OK: brief unchanged${notes.length ? ` (${notes.join("; ")})` : ""}`;
  }
  await emit(`Writing brief: ${built.claims.length} evidence claim(s), recommended ${built.recommendedProduct?.replace("_", " ").toLowerCase() ?? "nothing yet"}`);

  // --- 3. Angle: AI when available and grounded, template otherwise ---------------
  let salesAngle = built.templateAngle;
  let mainProblem = built.mainProblem;
  let coldCallOpener = built.coldCallOpener;
  let discoveryQuestion = built.discoveryQuestion;
  let angleSource: "AI" | "TEMPLATE" = "TEMPLATE";
  let model: string | null = null;
  if (provider && built.recommendedProduct && built.claims.length > 0) {
    try {
      const { data, model: usedModel } = await writeSalesAngle(
        {
          dealership: dealer.name,
          recommendedProduct: PRODUCT_LABEL[built.recommendedProduct],
          productDescription: PRODUCT_DESCRIPTION[built.recommendedProduct],
          secondaryProduct: built.secondaryProduct ? PRODUCT_LABEL[built.secondaryProduct] : null,
          claims: built.claims.map((c) => ({ id: c.id, kind: c.kind, confidence: c.confidence, text: c.text })),
        },
        budget,
      );
      const grounded = angleIsGrounded(data, built.claims);
      if (grounded.ok) {
        salesAngle = data.salesAngle;
        mainProblem = data.mainProblem;
        coldCallOpener = data.coldCallOpener;
        discoveryQuestion = data.discoveryQuestion;
        angleSource = "AI";
        model = usedModel;
      } else {
        notes.push(`AI angle rejected (${grounded.reason}); template used`);
      }
    } catch (err) {
      notes.push(`AI angle unavailable (${(err as Error).message}); template used`);
    }
  }

  await db().insert(salesBriefs).values({
    dealershipId,
    priorityScore: fresh?.priorityScore ?? 0,
    recommendedProduct: built.recommendedProduct,
    secondaryProduct: built.secondaryProduct,
    mainProblem,
    claims: built.claims.map(({ text, kind, confidence, evidence }) => ({ text, kind, confidence, evidence })),
    salesAngle,
    coldCallOpener,
    discoveryQuestion,
    angleSource,
    recommendedRoles: built.recommendedRoles,
    nextAction: built.nextAction,
    model,
    inputHash: built.inputHash,
  });

  await emit(`Brief ready (${angleSource === "AI" ? "AI-written" : "template"} angle)`, { detail: mainProblem, status: "DONE", kind: "finding.created" });
  // The brief's next action is a suggestion; it never overwrites one an operator typed in.
  const systemActions = /^(Wait for response timer|Review interaction response|Review website research|Research group ownership|Contact )/;
  if (!fresh?.nextAction || systemActions.test(fresh.nextAction)) {
    await db().update(dealerships).set({ nextAction: built.nextAction, updatedAt: new Date() }).where(eq(dealerships.id, dealershipId));
  }
  return `OK: brief generated (${angleSource.toLowerCase()} angle, ${built.claims.length} claims)${notes.length ? ` — ${notes.join("; ")}` : ""}`;
}
