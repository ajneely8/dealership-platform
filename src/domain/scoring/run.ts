import { and, count, desc, eq, gte, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import {
  dealerGroups,
  dealerships,
  findings,
  inventorySnapshots,
  responses,
  scoreHistory,
  scores,
  signals,
  socialObservations,
  testInteractions,
  websiteObservations,
} from "@/db/schema";
import { audit } from "@/lib/audit";
import { getSettings } from "@/lib/settings";
import { emit } from "@/lib/agent-events";
import { PRODUCTS, type Product } from "../constants";
import { computePriority, rankProducts, scoreProducts, type ScoringFacts } from "./engine";

/** Collects the stored records scoring is allowed to use. No network, no LLM. */
export async function buildFacts(dealershipId: string, now: Date = new Date()): Promise<ScoringFacts | null> {
  const [dealer] = await db().select().from(dealerships).where(eq(dealerships.id, dealershipId)).limit(1);
  if (!dealer) return null;

  const [observation] = await db()
    .select()
    .from(websiteObservations)
    .where(eq(websiteObservations.dealershipId, dealershipId))
    .orderBy(desc(websiteObservations.timestamp))
    .limit(1);

  const inventory = await db()
    .select()
    .from(inventorySnapshots)
    .where(eq(inventorySnapshots.dealershipId, dealershipId))
    .orderBy(desc(inventorySnapshots.capturedAt))
    .limit(5);

  const [interaction] = await db()
    .select()
    .from(testInteractions)
    .where(and(eq(testInteractions.dealershipId, dealershipId), eq(testInteractions.testType, "FORM"), isNotNull(testInteractions.submittedAt)))
    .orderBy(desc(testInteractions.submittedAt))
    .limit(1);
  const interactionResponses = interaction
    ? await db().select().from(responses).where(eq(responses.interactionId, interaction.id)).orderBy(responses.receivedAt)
    : [];

  const signalRows = await db()
    .select()
    .from(signals)
    .where(and(eq(signals.dealershipId, dealershipId), gte(signals.detectedAt, new Date(now.getTime() - 180 * 86_400_000))));

  const socialRows = await db()
    .select()
    .from(socialObservations)
    .where(eq(socialObservations.dealershipId, dealershipId))
    .orderBy(desc(socialObservations.observedAt));
  const latestSocial = new Map<string, (typeof socialRows)[number]>();
  for (const s of socialRows) if (!latestSocial.has(s.platform)) latestSocial.set(s.platform, s);

  let groupRooftops = 1;
  if (dealer.groupId) {
    const [group] = await db().select({ storeCount: dealerGroups.storeCount }).from(dealerGroups).where(eq(dealerGroups.id, dealer.groupId)).limit(1);
    const [n] = await db().select({ n: count() }).from(dealerships).where(eq(dealerships.groupId, dealer.groupId));
    groupRooftops = Math.max(group?.storeCount ?? 0, n?.n ?? 0, 1);
  }

  return {
    now,
    observation: observation
      ? {
          id: observation.id,
          timestamp: observation.timestamp,
          websiteStatus: observation.websiteStatus,
          chatPresent: observation.chatPresent,
          chatWorking: observation.chatWorking,
          chatQuality: observation.chatQuality,
          leadFormCount: observation.leadFormCount,
          inventoryPagePresent: observation.inventoryPagePresent,
          inventoryAlertsPresent: observation.inventoryAlertsPresent,
          servicePagePresent: observation.servicePagePresent,
          serviceSchedulerPresent: observation.serviceSchedulerPresent,
          service: observation.service,
        }
      : null,
    inventory: inventory.map((s) => ({ id: s.id, capturedAt: s.capturedAt, total: s.total, vdpUrls: s.vdpUrls, confidence: s.confidence })),
    interaction:
      interaction && interaction.submittedAt
        ? {
            id: interaction.id,
            submittedAt: interaction.submittedAt,
            closed: interaction.status === "COMPLETED",
            responses: interactionResponses.map((r) => ({
              id: r.id,
              channel: r.channel,
              responseSeconds: r.responseSeconds,
              classification: r.classification,
              personalizationScore: r.personalizationScore,
              vehicleReferenced: r.vehicleReferenced,
            })),
          }
        : null,
    signals: signalRows.map((s) => ({ id: s.id, type: s.type, detectedAt: s.detectedAt, confidence: s.confidence, kind: s.kind })),
    social: [...latestSocial.values()].map((s) => ({
      id: s.id,
      platform: s.platform,
      postsLast30Days: s.postsLast30Days,
      inventoryPostsLast30Days: s.inventoryPostsLast30Days,
      customerQuestions: s.customerQuestions,
      unansweredQuestions: s.unansweredQuestions,
      adActivity: s.adActivity,
      confidence: s.confidence,
    })),
    groupRooftops,
  };
}

export type ScoringOutcome = { priority: number; recommendedProduct: Product | null; changed: boolean };

/**
 * Scores one rooftop and persists: per-product scores with reasons, the findings table
 * (observed fact vs inference), the priority breakdown, and history rows for anything that moved.
 * Idempotent — re-running with unchanged evidence writes the same values and no history.
 */
export async function runScoring(dealershipId: string, actor = "system:scoring"): Promise<ScoringOutcome | null> {
  const now = new Date();
  const facts = await buildFacts(dealershipId, now);
  if (!facts) return null;
  const settings = await getSettings();
  const config = { weights: settings.scoringWeights, thresholds: settings.scoringThresholds };

  const result = scoreProducts(facts, config);
  const priority = computePriority(facts, result, config);
  const top = rankProducts(result)[0]!;
  const recommendedProduct = top.score > 0 ? top.product : null;

  const existing = await db().select().from(scores).where(eq(scores.dealershipId, dealershipId));
  const [dealer] = await db()
    .select({ priorityScore: dealerships.priorityScore, pipelineStage: dealerships.pipelineStage })
    .from(dealerships)
    .where(eq(dealerships.id, dealershipId))
    .limit(1);
  let changed = false;

  await db().transaction(async (tx) => {
    for (const p of PRODUCTS) {
      const prev = existing.find((e) => e.product === p);
      const next = result[p];
      await tx
        .insert(scores)
        .values({ dealershipId, product: p, score: next.score, reasons: next.reasons, computedAt: now })
        .onConflictDoUpdate({ target: [scores.dealershipId, scores.product], set: { score: next.score, reasons: next.reasons, computedAt: now } });
      if ((prev?.score ?? 0) !== next.score) {
        changed = true;
        await tx.insert(scoreHistory).values({ dealershipId, subject: p, previous: prev?.score ?? null, score: next.score, changedAt: now });
      }
    }
    if ((dealer?.priorityScore ?? 0) !== priority.total) {
      changed = true;
      await tx.insert(scoreHistory).values({ dealershipId, subject: "PRIORITY", previous: dealer?.priorityScore ?? null, score: priority.total, changedAt: now });
    }

    // Findings are a projection of the current reasons, so they are replaced wholesale.
    await tx.delete(findings).where(eq(findings.dealershipId, dealershipId));
    const rows = PRODUCTS.flatMap((p) =>
      result[p].reasons.map((r) => ({
        dealershipId,
        kind: r.kind,
        confidence: r.confidence,
        product: p,
        key: r.ruleId,
        statement: r.label,
        evidence: r.evidence,
      })),
    );
    if (rows.length) await tx.insert(findings).values(rows);

    // First time an account earns a real score it moves out of RESEARCHING on its own;
    // later pipeline stages are only ever changed by a person.
    const promote = dealer?.pipelineStage === "RESEARCHING" && priority.total >= 60;
    await tx
      .update(dealerships)
      .set({
        priorityScore: priority.total,
        priorityBreakdown: priority,
        recommendedProduct,
        ...(promote ? { pipelineStage: "READY_TO_CONTACT" as const } : {}),
        updatedAt: now,
      })
      .where(eq(dealerships.id, dealershipId));
  });

  await emit(`Scored: ${PRODUCTS.map((p) => `${p.replace("_", " ").toLowerCase()} ${result[p].score}`).join(", ")} · priority ${priority.total}`, {
    detail: recommendedProduct ? `Recommended ${recommendedProduct.replace("_", " ").toLowerCase()}; ${PRODUCTS.reduce((a, p) => a + result[p].reasons.length, 0)} rule(s) fired` : "No rule fired",
    status: "DONE",
    kind: "finding.created",
  });
  if (changed) {
    await audit(actor, "score.changed", "dealership", dealershipId, {
      priority: priority.total,
      previousPriority: dealer?.priorityScore ?? null,
      scores: Object.fromEntries(PRODUCTS.map((p) => [p, result[p].score])),
    });
  }
  return { priority: priority.total, recommendedProduct, changed };
}
