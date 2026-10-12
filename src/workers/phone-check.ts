import { eq } from "drizzle-orm";
import { db } from "@/db";
import { dealerships } from "@/db/schema";
import { RECEPTIONIST_LABEL } from "@/domain/constants";
import { classifyPhoneAnswer } from "@/domain/phone-answer";
import { emit } from "@/lib/agent-events";
import { audit } from "@/lib/audit";
import { saveScreenshot } from "@/lib/evidence";
import { logger } from "@/lib/logger";
import { getSettings } from "@/lib/settings";
import { placeScriptedCall, twilioConfigured } from "@/lib/telephony";
import { enqueue } from "@/queue";

/**
 * Phone check: Charlie calls the dealership's main number once, speaks the configured script,
 * records what answers for under a minute, hangs up, and classifies the answer — a person, an AI
 * receptionist, a phone menu, voicemail or no answer. The recording and transcript are kept as
 * evidence. One call per dealership per cooldown period; never without testing approval.
 */
export async function runPhoneCheck(dealershipId: string): Promise<string> {
  if (!twilioConfigured()) return "SKIPPED: Twilio is not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER)";
  const settings = await getSettings();
  if (!settings.testingEnabled) return "SKIPPED: controlled testing is switched off";
  const [d] = await db().select().from(dealerships).where(eq(dealerships.id, dealershipId)).limit(1);
  if (!d) return "SKIPPED: dealership no longer exists";
  if (!d.testingApproved) return "SKIPPED: this dealership is not approved for testing";
  if (d.suppressed) return "SKIPPED: this dealership is suppressed";
  const to = d.normalizedPhone ?? d.phone;
  if (!to) return "SKIPPED: no phone number on file";
  const cooldownMs = settings.interactionCooldownDays * 86_400_000;
  if (d.receptionistCheckedBy?.startsWith("system:phone") && d.receptionistCheckedAt && Date.now() - d.receptionistCheckedAt.getTime() < cooldownMs) {
    return `SKIPPED: already called on ${d.receptionistCheckedAt.toISOString().slice(0, 10)}; cooldown is ${settings.interactionCooldownDays} days`;
  }

  await emit(`Calling ${d.name} at ${to}`, { dealershipId, detail: settings.phoneHangUpOnHuman ? "listening only; hangs up if a person answers" : "listening only" });
  const call = await placeScriptedCall({ to, script: settings.phoneCheckScript, recordSeconds: 45, hangUpOnHuman: settings.phoneHangUpOnHuman });
  const verdict = classifyPhoneAnswer({ callStatus: call.status, answeredBy: call.answeredBy, transcript: call.transcript, durationSeconds: call.durationSeconds, hungUpOnHuman: call.hungUpOnHuman, rings: call.rings });
  if (call.rings !== null) await emit(`Answered after about ${call.rings} ring${call.rings === 1 ? "" : "s"} (${call.ringSeconds}s)`, { dealershipId, kind: "finding.created" });
  logger.info({ dealershipId, call: call.callSid, status: call.status, answeredBy: call.answeredBy, verdict }, "phone check");

  let evidenceId: string | null = null;
  if (call.recording) {
    const saved = await saveScreenshot({ dealershipId, type: "CALL", body: call.recording, sourceUrl: `tel:${to}`, contentType: "audio/mpeg" });
    evidenceId = saved.id;
  }
  const note = `${RECEPTIONIST_LABEL[verdict.status]} — ${verdict.reason} (${verdict.confidence.toLowerCase()} confidence; call ${call.status}${call.durationSeconds ? `, ${call.durationSeconds}s` : ""})`;
  await db().update(dealerships).set({ receptionist: verdict.status, receptionistNote: note.slice(0, 300), receptionistTranscript: call.transcript?.slice(0, 4000) ?? null, receptionistCheckedAt: new Date(), receptionistCheckedBy: "system:phone-check", updatedAt: new Date() }).where(eq(dealerships.id, dealershipId));
  await audit("system:phone-check", "phone.checked", "dealership", dealershipId, { callSid: call.callSid, status: call.status, answeredBy: call.answeredBy, verdict: verdict.status, recordingSid: call.recordingSid, rings: call.rings, hungUpOnHuman: call.hungUpOnHuman });
  await emit(`Phone answered by: ${RECEPTIONIST_LABEL[verdict.status]}`, { dealershipId, evidenceId, detail: `${verdict.reason}${call.transcript ? ` · "${call.transcript.slice(0, 140)}"` : ""}`, status: "DONE", kind: "finding.created" });
  await enqueue("scoring", { dealershipId });
  return `OK: ${RECEPTIONIST_LABEL[verdict.status]} (${verdict.confidence.toLowerCase()})`;
}
