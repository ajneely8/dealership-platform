import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { buyingIntentScores, contacts, dealerships, salesTouches, websiteObservations } from "@/db/schema";
import { emit } from "@/lib/agent-events";
import { getSettings } from "@/lib/settings";
import { INTENT_BAND_LABEL, READINESS_LABEL, scoreBuyingIntent, type IntentResult } from "./intent";
import { buildFacts } from "./scoring/run";

/**
 * Computes and stores the buying-intent score for one dealership. Runs after every scoring job
 * (Atlas) and after every sales outcome logged by a person, so the score and the readiness
 * always reflect the newest evidence. Returns null when the dealership is unknown.
 */
export async function runBuyingIntent(dealershipId: string, actor: "atlas" | "orion" = "atlas"): Promise<IntentResult | null> {
  const now = new Date();
  const facts = await buildFacts(dealershipId, now);
  if (!facts) return null;
  const [[dealer], contactRows, touches, [obs]] = await Promise.all([
    db().select({ receptionist: dealerships.receptionist, buyingIntent: dealerships.buyingIntent }).from(dealerships).where(eq(dealerships.id, dealershipId)).limit(1),
    db().select({ title: contacts.title }).from(contacts).where(eq(contacts.dealershipId, dealershipId)),
    db().select({ outcome: salesTouches.outcome }).from(salesTouches).where(eq(salesTouches.dealershipId, dealershipId)).orderBy(desc(salesTouches.createdAt)).limit(50),
    db().select({ service: websiteObservations.service }).from(websiteObservations).where(eq(websiteObservations.dealershipId, dealershipId)).orderBy(desc(websiteObservations.timestamp)).limit(1),
  ]);
  if (!dealer) return null;
  const serviceContacts = ((obs?.service as { contactMethods?: string[] } | null)?.contactMethods ?? []).map((m) => m.toUpperCase());
  const result = scoreBuyingIntent({
    facts,
    contactTitles: contactRows.map((c) => c.title ?? "").filter(Boolean),
    outcomes: touches.map((t) => t.outcome),
    receptionist: dealer.receptionist,
    smsOffered: serviceContacts.includes("SMS"),
  });

  await db()
    .insert(buyingIntentScores)
    .values({ dealershipId, score: result.score, band: result.band, readiness: result.readiness, confidence: result.confidence, signals: result.signals, ruleVersion: result.ruleVersion, computedAt: now })
    .onConflictDoUpdate({ target: buyingIntentScores.dealershipId, set: { score: result.score, band: result.band, readiness: result.readiness, confidence: result.confidence, signals: result.signals, ruleVersion: result.ruleVersion, computedAt: now } });
  await db().update(dealerships).set({ buyingIntent: result.score, buyerReadiness: result.readiness, intentConfidence: result.confidence, intentAt: now }).where(eq(dealerships.id, dealershipId));
  if (dealer.buyingIntent !== result.score) {
    const fired = result.signals.filter((s) => s.points > 0).map((s) => s.label);
    await emit(`Buying intent ${result.score}/100 — ${INTENT_BAND_LABEL[result.band]} · ${READINESS_LABEL[result.readiness]}`, { agent: actor, dealershipId, detail: fired.length ? fired.join("; ") : "no signal scored yet; unknowns are not counted against the dealership", status: "DONE", kind: "finding.created" });
  }
  return result;
}

/** Figures for the Command Center: priority bands, confirmed interest, meetings, customers and projected MRR. */
export async function intentMetrics() {
  const settings = await getSettings();
  const [[bands], [confirmed], [meetings], [customers], [mrr]] = await Promise.all([
    db().select({ high: sql<number>`count(*) filter (where ${dealerships.buyingIntent} >= 75)`, medium: sql<number>`count(*) filter (where ${dealerships.buyingIntent} between 45 and 74)`, scored: sql<number>`count(*) filter (where ${dealerships.buyingIntent} is not null)` }).from(dealerships).where(eq(dealerships.suppressed, false)),
    db().select({ n: count() }).from(dealerships).where(and(eq(dealerships.suppressed, false), eq(dealerships.buyerReadiness, "CONFIRMED_INTEREST"))),
    db().select({ n: sql<number>`count(distinct ${salesTouches.dealershipId})` }).from(salesTouches).where(eq(salesTouches.outcome, "BOOKED_MEETING")),
    db().select({ n: sql<number>`count(distinct ${salesTouches.dealershipId})` }).from(salesTouches).where(eq(salesTouches.outcome, "SOLD")),
    db().select({ n: sql<number>`coalesce(sum(${salesTouches.mrr}), 0)` }).from(salesTouches).where(and(eq(salesTouches.outcome, "SOLD"), gte(salesTouches.mrr, 0))),
  ]);
  const high = Number(bands?.high ?? 0);
  return {
    scored: Number(bands?.scored ?? 0),
    high,
    medium: Number(bands?.medium ?? 0),
    confirmed: Number(confirmed?.n ?? 0),
    meetingsBooked: Number(meetings?.n ?? 0),
    customersClosed: Number(customers?.n ?? 0),
    /** Earned: monthly value logged on sold deals. */
    mrrEarned: Number(mrr?.n ?? 0),
    /** Projected, not earned: high-priority prospects × the price per location in Settings. */
    mrrProjected: high * settings.mrrPerLocation,
    mrrPerLocation: settings.mrrPerLocation,
  };
}
