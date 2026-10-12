import { eq } from "drizzle-orm";
import { db } from "@/db";
import { dealerships, responses, testInteractions } from "@/db/schema";
import { evaluateMilestones, firstResponseSeconds, nextMilestoneAt } from "@/domain/response-timing";
import { getSettings } from "@/lib/settings";
import { enqueue } from "@/queue";
import { emit } from "@/lib/agent-events";

/**
 * Runs at each response milestone (5m, 15m, 1h, 4h, 24h, 72h). It only observes: it records which
 * milestones passed without a response, re-scores, and schedules the next check. It never sends anything.
 */
export async function runResponseCheck(interactionId: string): Promise<string> {
  const [interaction] = await db().select().from(testInteractions).where(eq(testInteractions.id, interactionId)).limit(1);
  if (!interaction || interaction.status !== "MONITORING" || !interaction.submittedAt) return "SKIPPED: interaction is not being monitored";

  const now = new Date();
  const settings = await getSettings();
  const all = await db().select({ responseSeconds: responses.responseSeconds }).from(responses).where(eq(responses.interactionId, interactionId));
  const milestones = evaluateMilestones(interaction.submittedAt, all, now);
  const windowEnd = new Date(interaction.submittedAt.getTime() + settings.responseMonitorHours * 3_600_000);
  const closing = now.getTime() >= windowEnd.getTime();

  await db()
    .update(testInteractions)
    .set({ milestones, firstResponseSeconds: firstResponseSeconds(all), ...(closing ? { status: "COMPLETED" as const, completedAt: now } : {}) })
    .where(eq(testInteractions.id, interactionId));

  const passed = Object.entries(milestones).filter(([, v]) => v === false).map(([k]) => k);
  await emit(closing ? `Monitoring window closed: ${all.length} repl${all.length === 1 ? "y" : "ies"} in ${settings.responseMonitorHours}h` : all.length ? `Checked: first reply ${firstResponseSeconds(all)}s after submission` : `Checked: no reply yet${passed.length ? ` (${passed.join(", ")} passed)` : ""}`, { interactionId, status: closing ? "DONE" : "INFO" });
  if (closing) {
    const retest = new Date(interaction.submittedAt.getTime() + Math.max(30, settings.interactionCooldownDays) * 86_400_000);
    await db()
      .update(dealerships)
      .set({ nextAction: "Review interaction response", nextActionDue: retest, updatedAt: now })
      .where(eq(dealerships.id, interaction.dealershipId));
  } else {
    const next = nextMilestoneAt(interaction.submittedAt, now);
    const at = next && next.getTime() < windowEnd.getTime() ? next : windowEnd;
    await enqueue("response-check", { interactionId, dealershipId: interaction.dealershipId }, { key: String(at.getTime()), delayMs: Math.max(1_000, at.getTime() - now.getTime()) });
  }

  await enqueue("scoring", { dealershipId: interaction.dealershipId });
  return closing ? "COMPLETED: monitoring window closed" : `OK: ${all.length} response(s) so far`;
}
