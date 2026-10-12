import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { dealerships, settings as settingsTable, websiteObservations } from "@/db/schema";
import { AGENTS, type AgentKey } from "@/domain/agents";
import { requestChatTestFor } from "@/domain/chat-requests";
import { emit } from "@/lib/agent-events";
import { audit } from "@/lib/audit";
import { getSettings } from "@/lib/settings";
import { twilioConfigured } from "@/lib/telephony";
import { enqueue } from "@/queue";

/**
 * The relay: a newly found dealership moves through the workforce one agent at a time, and Nova
 * does not screen the next candidate until the baton has gone all the way round.
 *
 *   Nova     reads the website (discovery → website scan)
 *   Sentinel estimates monthly units and gross sales from the inventory just read
 *   Charlie  calls the dealership, then tests the chatbot
 *   Sage     reads the social presence
 *   Hunter   checks hiring and growth signals
 *   Atlas    scores it
 *   Blaze    writes the call brief → the relay is over and Nova screens the next one
 *
 * Only one dealership holds the baton at a time. The state is one settings row, so every worker
 * and page sees the same thing. A relay that has not moved for RELAY_STALE_MINUTES is released
 * so one stuck job can never stop prospecting for good; a stage that gets parked for research
 * hours or fails for good releases it at once.
 */
export const RELAY_STAGES = ["nova", "sentinel", "charlie", "sage", "hunter", "atlas", "blaze"] as const;
export type RelayStage = (typeof RELAY_STAGES)[number];
export type Relay = { dealershipId: string; name: string; stage: RelayStage; startedAt: string; stageAt: string; note: string };

const KEY = "relay";
export const RELAY_STALE_MINUTES = 30;

export async function currentRelay(): Promise<Relay | null> {
  const [row] = await db().select({ value: settingsTable.value }).from(settingsTable).where(eq(settingsTable.key, KEY)).limit(1);
  const v = row?.value as Partial<Relay> | null | undefined;
  if (!v || typeof v !== "object" || !v.dealershipId || !v.stage) return null;
  return v as Relay;
}

async function save(relay: Relay | null, actor: string): Promise<void> {
  const now = new Date();
  // The value column cannot hold null: no relay means no row.
  if (!relay) {
    await db().delete(settingsTable).where(eq(settingsTable.key, KEY));
    return;
  }
  await db()
    .insert(settingsTable)
    .values({ key: KEY, value: relay, updatedBy: actor, updatedAt: now })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value: relay, updatedBy: actor, updatedAt: now } });
}

/** The relay a dealership currently holds, or null when it is not the one with the baton. */
export async function relayFor(dealershipId: string): Promise<Relay | null> {
  const r = await currentRelay();
  return r && r.dealershipId === dealershipId ? r : null;
}

export async function relayStart(dealershipId: string, name: string): Promise<void> {
  const now = new Date().toISOString();
  await save({ dealershipId, name, stage: "nova", startedAt: now, stageAt: now, note: "reading the website" }, "system:relay");
}

/** One agent passes the dealership to the next; the event is the signal the workforce stage animates. */
export async function relayHandOff(dealershipId: string, from: AgentKey, to: RelayStage, note: string): Promise<void> {
  const r = await relayFor(dealershipId);
  if (!r) return;
  await save({ ...r, stage: to, stageAt: new Date().toISOString(), note }, `system:${from}`);
  await emit(`Hand-off to ${AGENTS[to].name} — ${note}`, { agent: from, dealershipId, detail: `${r.name} · stage ${RELAY_STAGES.indexOf(to) + 1} of ${RELAY_STAGES.length}`, status: "DONE", kind: "task.created" });
}

/** Ends the relay (done, failed, parked or removed) so Nova can pick up the next candidate. */
export async function relayFinish(dealershipId: string, agent: AgentKey, reason: string): Promise<boolean> {
  const r = await relayFor(dealershipId);
  if (!r) return false;
  await save(null, `system:${agent}`);
  const minutes = Math.max(1, Math.round((Date.now() - Date.parse(r.startedAt)) / 60_000));
  await emit(`Relay finished for ${r.name} — ${reason}`, { agent, dealershipId, detail: `${minutes} min from first look to hand-back · Nova is free to screen the next dealership`, status: "DONE", kind: "task.completed" });
  await audit(`system:${agent}`, "relay.finished", "dealership", dealershipId, { reason, minutes, lastStage: r.stage });
  return true;
}

/**
 * Is the baton out? Returns the live relay, or null when Nova may screen the next candidate.
 * A relay that has sat on one stage for too long is released here, with a note from Orion.
 */
export async function relayHolding(): Promise<Relay | null> {
  const r = await currentRelay();
  if (!r) return null;
  if (Date.now() - Date.parse(r.stageAt) > RELAY_STALE_MINUTES * 60_000) {
    await save(null, "system:orion");
    await emit(`Released the relay: ${r.name} sat with ${AGENTS[r.stage].name} for over ${RELAY_STALE_MINUTES} minutes`, { agent: "orion", dealershipId: r.dealershipId, detail: `last note: ${r.note}`, status: "BLOCKED", kind: "task.blocked" });
    return null;
  }
  return r;
}

// ---------------------------------------------------------------------------
// The chain itself: what each agent does with the baton when its job is done.
// ---------------------------------------------------------------------------

/** Nova has read the website. Sentinel is next: what does this lot sell a month, and what is it worth. */
export async function afterNova(dealershipId: string, manual: boolean | undefined): Promise<void> {
  if (!(await relayFor(dealershipId))) return;
  await relayHandOff(dealershipId, "nova", "sentinel", "website read; estimate monthly sales from the lot");
  await enqueue("estimate", { dealershipId, manual });
}

/** Sentinel has written its estimate. Charlie is next: call first, chatbot after. */
export async function afterSentinel(dealershipId: string, manual: boolean | undefined): Promise<void> {
  const r = await relayFor(dealershipId);
  if (!r || r.stage !== "sentinel") return;
  const s = await getSettings();
  const [d] = await db().select({ phone: dealerships.phone, approved: dealerships.testingApproved }).from(dealerships).where(eq(dealerships.id, dealershipId)).limit(1);
  if (!d) return;
  if (s.phoneCheckMode === "auto" && d.phone && twilioConfigured() && s.testingEnabled) {
    if (!d.approved) await db().update(dealerships).set({ testingApproved: true, testingApprovedBy: "system:relay", testingApprovedAt: new Date(), updatedAt: new Date() }).where(eq(dealerships.id, dealershipId));
    await relayHandOff(dealershipId, "sentinel", "charlie", "estimate written; call the dealership");
    await enqueue("phone-check", { dealershipId, manual });
    return;
  }
  await relayHandOff(dealershipId, "sentinel", "charlie", d.phone ? "estimate written; phone checks are off, test the chatbot" : "estimate written; no phone on file, test the chatbot");
  await charlieChat(dealershipId, manual);
}

/** Charlie has finished the call. Same agent, next task: the chatbot. */
export async function afterPhoneCheck(dealershipId: string, manual: boolean | undefined): Promise<void> {
  if (!(await relayFor(dealershipId))) return;
  await charlieChat(dealershipId, manual);
}

async function charlieChat(dealershipId: string, manual: boolean | undefined): Promise<void> {
  const s = await getSettings();
  const [obs] = await db().select({ chatPresent: websiteObservations.chatPresent }).from(websiteObservations).where(eq(websiteObservations.dealershipId, dealershipId)).orderBy(desc(websiteObservations.timestamp)).limit(1);
  if (!obs?.chatPresent) {
    await emit("No chat widget on this website — nothing to test", { agent: "charlie", dealershipId, status: "DONE", kind: "finding.created" });
    return afterCharlie(dealershipId, manual, "no chatbot to test");
  }
  if (s.chatTestMode === "manual") return afterCharlie(dealershipId, manual, "chat tests are set to manual");
  const r = await requestChatTestFor({ dealershipId, mode: s.chatTestMode, actor: "system:relay" });
  if (r.created && r.status === "APPROVED") return; // the interaction job hands off when the conversation ends
  return afterCharlie(dealershipId, manual, r.created ? "chat test is waiting for a person to approve it" : `chat test not run: ${r.detail ?? "not eligible"}`);
}

/** Charlie is done with the dealership. Sage reads its social presence next. */
export async function afterCharlie(dealershipId: string, manual: boolean | undefined, note = "call and chatbot done"): Promise<void> {
  if (!(await relayFor(dealershipId))) return;
  await relayHandOff(dealershipId, "charlie", "sage", note);
  await enqueue("social", { dealershipId, manual });
}

export async function afterSage(dealershipId: string, manual: boolean | undefined): Promise<void> {
  const r = await relayFor(dealershipId);
  if (!r || r.stage !== "sage") return;
  await relayHandOff(dealershipId, "sage", "hunter", "social presence read; check hiring and growth");
  await enqueue("signals", { dealershipId, manual });
}

export async function afterHunter(dealershipId: string): Promise<void> {
  const r = await relayFor(dealershipId);
  if (!r || r.stage !== "hunter") return;
  await relayHandOff(dealershipId, "hunter", "atlas", "signals checked; score it"); // scoring is already queued by the signals job
}

export async function afterAtlas(dealershipId: string): Promise<void> {
  const r = await relayFor(dealershipId);
  if (!r || r.stage !== "atlas") return;
  await relayHandOff(dealershipId, "atlas", "blaze", "scored; write the call brief"); // sales-intel is already queued by scoring
}

export async function afterBlaze(dealershipId: string): Promise<void> {
  const r = await relayFor(dealershipId);
  if (!r || r.stage !== "blaze") return;
  await relayFinish(dealershipId, "blaze", "call brief ready");
}
