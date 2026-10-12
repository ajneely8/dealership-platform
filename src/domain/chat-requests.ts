import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { dealerships, testIdentities, testInteractions } from "@/db/schema";
import { APPROVED_MESSAGES } from "@/domain/constants";
import { checkEligibility } from "@/domain/eligibility";
import { emit } from "@/lib/agent-events";
import { audit } from "@/lib/audit";
import { enqueue } from "@/queue";

export type ChatTestMode = "manual" | "request" | "auto";

/**
 * Puts a chatbot test in front of Charlie for a dealership that has a reachable chat widget.
 *
 *   request — creates the test and leaves it waiting for a person's approval (default)
 *   auto    — approves it as well, so Charlie runs it on the next tick
 *   manual  — does nothing; tests are requested by hand on the dealership page
 *
 * Every other rule still applies: Sentinel's eligibility check (suppression, cooldown per test
 * type, one active test), the approved-question list, and the configured test identity.
 */
export async function requestChatTestFor(args: { dealershipId: string; mode: ChatTestMode; actor: string }): Promise<{ created: boolean; status?: string; detail?: string }> {
  if (args.mode === "manual") return { created: false, detail: "chat tests are requested by hand" };
  const [d] = await db().select({ id: dealerships.id, website: dealerships.website, testingApproved: dealerships.testingApproved }).from(dealerships).where(eq(dealerships.id, args.dealershipId)).limit(1);
  if (!d?.website) return { created: false, detail: "no website" };
  const [identity] = await db().select({ id: testIdentities.id }).from(testIdentities).where(eq(testIdentities.active, true)).orderBy(testIdentities.createdAt).limit(1);
  if (!identity) return { created: false, detail: "no active test identity is configured" };
  if (!d.testingApproved) {
    await db().update(dealerships).set({ testingApproved: true, testingApprovedBy: args.actor, testingApprovedAt: new Date(), updatedAt: new Date() }).where(eq(dealerships.id, d.id));
    await audit(args.actor, "dealership.testing_approved", "dealership", d.id, { by: "chat test mode" });
  }
  const message = APPROVED_MESSAGES[0];
  const eligibility = await checkEligibility({ dealershipId: d.id, identityId: identity.id, targetUrl: d.website, testType: "CHAT", formType: null, form: null });
  const base = { dealershipId: d.id, identityId: identity.id, testType: "CHAT" as const, formType: null, message, sourceUrl: d.website, requestedBy: args.actor };
  if (!eligibility.eligible) {
    const detail = eligibility.reasons.map((r) => r.message).join(" ");
    await emit("Chat test not requested", { agent: "orion", dealershipId: d.id, detail, status: "BLOCKED", kind: "task.blocked" });
    return { created: false, detail };
  }
  if (args.mode === "auto") {
    const [row] = await db().insert(testInteractions).values({ ...base, status: "APPROVED", approvedBy: args.actor, approvedAt: new Date() }).returning({ id: testInteractions.id });
    if (!row) return { created: false, detail: "could not create the test" };
    await audit(args.actor, "test.approved", "interaction", row.id, { dealershipId: d.id, type: "CHAT", auto: true });
    await enqueue("interaction", { interactionId: row.id, dealershipId: d.id, manual: true });
    await emit("Chat test approved automatically and handed to Charlie", { agent: "orion", dealershipId: d.id, interactionId: row.id, detail: "chat test mode: auto", status: "DONE", kind: "task.created" });
    return { created: true, status: "APPROVED" };
  }
  const [row] = await db().insert(testInteractions).values({ ...base, status: "PENDING_APPROVAL" }).returning({ id: testInteractions.id });
  if (!row) return { created: false, detail: "could not create the test" };
  await audit(args.actor, "test.requested", "interaction", row.id, { dealershipId: d.id, type: "CHAT", auto: true });
  await emit("Chat test queued for approval", { agent: "orion", dealershipId: d.id, interactionId: row.id, detail: "approve it under Interactions", kind: "task.created" });
  return { created: true, status: "PENDING_APPROVAL" };
}

/** Is a chat test already open or waiting for this dealership? */
export async function hasOpenChatTest(dealershipId: string): Promise<boolean> {
  const rows = await db()
    .select({ id: testInteractions.id })
    .from(testInteractions)
    .where(and(eq(testInteractions.dealershipId, dealershipId), eq(testInteractions.testType, "CHAT")))
    .limit(50);
  return rows.length > 0;
}
