import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { dealerships, responses, testIdentities, testInteractions, transcriptMessages, unmatchedInbound } from "@/db/schema";
import { audit } from "@/lib/audit";
import { normalizeDomain, normalizePhone } from "@/lib/normalize";
import { enqueue } from "@/queue";
import { emit } from "@/lib/agent-events";
import type { Channel } from "./constants";
import { classifyResponseByRule, evaluateMilestones, firstResponseSeconds, responseSeconds } from "./response-timing";

export type InboundMessage = {
  channel: Channel;
  receivedAt: Date;
  /** Who it came from: phone number or email address. */
  sender: string | null;
  /** Which test identity it was sent to: phone number or email address. */
  recipient: string | null;
  message: string | null;
  externalId: string | null;
};

/** Never keep anything that looks like a credential in evidence. */
export function redactSecrets(text: string | null): string | null {
  if (!text) return text;
  return text
    .replace(/\b(password|passcode|pin|otp|verification code|security code)\b(\s*(is|:)?\s*)\S+/gi, "$1$2[redacted]")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[redacted]");
}

/**
 * Records one dealership response against an interaction: computes the response time,
 * applies rule-based classification, appends to the transcript, refreshes milestones,
 * and queues re-scoring. Safe to call twice for the same provider message id.
 */
export async function recordResponse(args: {
  interactionId: string;
  channel: Channel;
  receivedAt: Date;
  sender: string | null;
  message: string | null;
  ingestedVia: "WEBHOOK" | "MANUAL" | "PROBE";
  externalId: string | null;
  actor: string;
}): Promise<{ id: string; responseSeconds: number } | { duplicate: true }> {
  const [interaction] = await db().select().from(testInteractions).where(eq(testInteractions.id, args.interactionId)).limit(1);
  if (!interaction) throw new Error("Interaction not found");
  if (!interaction.submittedAt) throw new Error("This interaction has not been submitted yet, so there is nothing to time a response against.");
  if (args.receivedAt.getTime() < interaction.submittedAt.getTime() - 60_000) {
    throw new Error("The response time is earlier than the submission time.");
  }

  if (args.externalId) {
    const [dupe] = await db().select({ id: responses.id }).from(responses).where(eq(responses.externalId, args.externalId)).limit(1);
    if (dupe) return { duplicate: true };
  }

  const seconds = responseSeconds(interaction.submittedAt, args.receivedAt);
  const message = redactSecrets(args.message);
  const rule = classifyResponseByRule({ channel: args.channel, message, sender: args.sender, responseSeconds: seconds, vehicleText: interaction.vehicleId });

  const [row] = await db()
    .insert(responses)
    .values({
      interactionId: interaction.id,
      channel: args.channel,
      receivedAt: args.receivedAt,
      responseSeconds: seconds,
      sender: args.sender,
      classification: rule.classification,
      humanOrAutomation: rule.humanOrAutomation,
      classifiedBy: "RULE",
      message,
      vehicleReferenced: rule.vehicleReferenced,
      callToAction: rule.callToAction,
      ingestedVia: args.ingestedVia,
      externalId: args.externalId,
    })
    .returning({ id: responses.id });
  if (!row) throw new Error("Failed to store response");

  await db().insert(transcriptMessages).values({
    interactionId: interaction.id,
    dealershipId: interaction.dealershipId,
    timestamp: args.receivedAt,
    speaker: "DEALERSHIP",
    channel: args.channel,
    message: message ?? (args.channel === "PHONE" ? "(phone call)" : "(no message body)"),
  });

  const all = await db().select({ responseSeconds: responses.responseSeconds }).from(responses).where(eq(responses.interactionId, interaction.id));
  await db()
    .update(testInteractions)
    .set({ firstResponseSeconds: firstResponseSeconds(all), milestones: evaluateMilestones(interaction.submittedAt, all, new Date()) })
    .where(eq(testInteractions.id, interaction.id));

  await audit(args.actor, "response.recorded", "interaction", interaction.id, { responseId: row.id, channel: args.channel, responseSeconds: seconds, via: args.ingestedVia });
  // Echo records every reply, however it arrived; the chat probe also logs its own line under Charlie.
  {
    await emit(`${args.channel === "PHONE" ? "Phone call" : args.channel === "SMS" ? "Text message" : args.channel === "EMAIL" ? "Email" : "Reply"} received ${seconds}s after submission`, { agent: "echo", dealershipId: interaction.dealershipId, interactionId: interaction.id, detail: `${rule.classification.toLowerCase().replace("_", " ")} · ${rule.humanOrAutomation.toLowerCase()} · via ${args.ingestedVia.toLowerCase()}`, status: "DONE", kind: "response.received" });
  }
  await enqueue("scoring", { dealershipId: interaction.dealershipId });
  return { id: row.id, responseSeconds: seconds };
}

/**
 * Ties an inbound webhook message to an interaction. It must match a configured test identity,
 * and then exactly one interaction that is currently being monitored. Anything ambiguous goes to
 * the unmatched queue for an operator instead of being guessed.
 */
export async function ingestInbound(msg: InboundMessage): Promise<{ matched: true; interactionId: string } | { matched: false; reason: string }> {
  const park = async (reason: string) => {
    await emit(`Inbound ${msg.channel.toLowerCase()} could not be matched to a test`, { agent: "echo", detail: reason, status: "BLOCKED" });
    await db().insert(unmatchedInbound).values({
      channel: msg.channel,
      receivedAt: msg.receivedAt,
      sender: msg.sender,
      recipient: msg.recipient,
      message: redactSecrets(msg.message),
      reason,
      externalId: msg.externalId,
    });
    return { matched: false as const, reason };
  };

  const identities = await db().select().from(testIdentities);
  const recipientPhone = normalizePhone(msg.recipient);
  const recipientEmail = msg.recipient?.trim().toLowerCase().match(/[^\s<>]+@[^\s<>]+/)?.[0] ?? null;
  const identity = identities.find((i) => (msg.channel === "EMAIL" ? recipientEmail !== null && i.email.toLowerCase() === recipientEmail : recipientPhone !== null && i.normalizedPhone === recipientPhone));
  if (!identity) return park("Recipient is not a configured test identity");

  const open = await db()
    .select({
      id: testInteractions.id,
      dealershipId: testInteractions.dealershipId,
      domain: dealerships.normalizedDomain,
      phone: dealerships.normalizedPhone,
    })
    .from(testInteractions)
    .innerJoin(dealerships, eq(dealerships.id, testInteractions.dealershipId))
    .where(and(eq(testInteractions.identityId, identity.id), inArray(testInteractions.status, ["MONITORING"])));
  if (open.length === 0) return park("No interaction is being monitored for this identity");

  let target = open.length === 1 ? open[0] : undefined;
  if (!target) {
    // Several open tests share this identity: only accept a sender we can tie to one dealership.
    const senderPhone = normalizePhone(msg.sender);
    const senderDomain = msg.sender?.includes("@") ? normalizeDomain(msg.sender.split("@").pop()?.replace(/[>\s].*$/, "")) : null;
    const candidates = open.filter((o) => (senderPhone && o.phone === senderPhone) || (senderDomain && o.domain === senderDomain));
    if (candidates.length === 1) target = candidates[0];
  }
  if (!target) return park(`${open.length} interactions are open for this identity and the sender did not identify one`);

  await recordResponse({
    interactionId: target.id,
    channel: msg.channel,
    receivedAt: msg.receivedAt,
    sender: msg.sender,
    message: msg.message,
    ingestedVia: "WEBHOOK",
    externalId: msg.externalId,
    actor: "system:webhook",
  });
  return { matched: true, interactionId: target.id };
}
