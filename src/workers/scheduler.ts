import { and, desc, eq, inArray, isNotNull, lte, or, isNull, sql, gte } from "drizzle-orm";
import { db } from "@/db";
import { dealerships, evidence, inventorySnapshots, jobRuns, signals, socialObservations, testInteractions, agentEvents } from "@/db/schema";
import type { QueueName } from "@/domain/constants";
import { expireSuppressions } from "@/domain/suppression";
import { logger } from "@/lib/logger";
import { getSettings } from "@/lib/settings";
import { isWithinWindow, nextWindowStart } from "@/domain/research-window";
import { emit } from "@/lib/agent-events";
import { evidenceStore } from "@/lib/storage";
import { enqueue, QUEUE_POLICY } from "@/queue";
import { prospectTick } from "./prospect";
import { relayFinish, relayFor } from "./relay";

const TICK_MS = 5 * 60_000;
/** Upper bound of jobs queued per kind per tick, so a big import drips into the queue instead of flooding it. */
const BATCH = 25;

async function lastRunAt(queue: QueueName, dealershipIds: string[]): Promise<Map<string, Date>> {
  if (dealershipIds.length === 0) return new Map();
  const rows = await db()
    .select({ dealershipId: jobRuns.dealershipId, last: sql<Date>`max(${jobRuns.startedAt})` })
    .from(jobRuns)
    .where(and(eq(jobRuns.queue, queue), inArray(jobRuns.dealershipId, dealershipIds)))
    .groupBy(jobRuns.dealershipId);
  return new Map(rows.filter((r) => r.dealershipId).map((r) => [r.dealershipId!, new Date(r.last)]));
}

/**
 * One pass of the recurring schedule. All cadences come from Settings. Passive research is
 * scheduled automatically; controlled interactions never are — those need a person to approve each one.
 */
/**
 * A job run still marked RUNNING well past its queue's timeout belongs to a job that ended without
 * being able to close its record (the pool was busy, or the process died). Close it honestly so no
 * agent is shown frozen mid-task, and hand back the relay if that dealership was holding it.
 */
export async function closeLostJobRuns(now = new Date()): Promise<number> {
  const running = await db().select({ id: jobRuns.id, queue: jobRuns.queue, startedAt: jobRuns.startedAt, dealershipId: jobRuns.dealershipId }).from(jobRuns).where(eq(jobRuns.status, "RUNNING"));
  let closed = 0;
  for (const r of running) {
    const limit = (QUEUE_POLICY[r.queue as QueueName]?.timeoutMs ?? 10 * 60_000) + 3 * 60_000;
    if (now.getTime() - r.startedAt.getTime() < limit) continue;
    await db().update(jobRuns).set({ status: "FAILED", error: "Lost track of this task: it ran past its time limit and its record was never closed", completedAt: now }).where(eq(jobRuns.id, r.id));
    closed += 1;
    if (r.dealershipId && (await relayFor(r.dealershipId))) await relayFinish(r.dealershipId, "orion", `${r.queue} ran out of time`);
  }
  if (closed) await emit(`Closed ${closed} task record(s) that had run past their time limit`, { agent: "orion", status: "BLOCKED", kind: "task.blocked" });
  return closed;
}

export async function schedulerTick(): Promise<Record<string, number>> {
  const settings = await getSettings();
  const now = new Date();
  await closeLostJobRuns(now).catch((err: Error) => logger.warn({ err: err.message }, "could not close lost job runs"));
  const counts: Record<string, number> = { "website-scan": 0, inventory: 0, signals: 0, social: 0, "response-check": 0 };
  const windowCfg = { enabled: settings.researchWindowEnabled, start: settings.researchWindowStart, end: settings.researchWindowEnd, timezone: settings.timezone };
  const inWindow = isWithinWindow(now, windowCfg);

  if (!inWindow) {
    // Say so once an hour, so Orion's feed shows why nothing is being scanned.
    const [recent] = await db()
      .select({ at: agentEvents.at })
      .from(agentEvents)
      .where(and(eq(agentEvents.agent, "orion"), eq(agentEvents.kind, "task.scheduled"), gte(agentEvents.at, new Date(now.getTime() - 3_600_000))))
      .limit(1);
    if (!recent) await emit("Outside research hours — holding website, inventory, hiring and social checks", { agent: "orion", detail: `Research resumes ${nextWindowStart(now, windowCfg).toLocaleString("en-US", { timeZone: settings.timezone, weekday: "short", hour: "numeric", minute: "2-digit" })} ${settings.timezone}; reply monitoring continues`, kind: "task.scheduled" });
  }

  if (inWindow) {

  // Website scans: nextCheck is set by each scan from websiteScanIntervalDays.
  const due = await db()
    .select({ id: dealerships.id })
    .from(dealerships)
    .where(and(eq(dealerships.paused, false), isNotNull(dealerships.website), or(isNull(dealerships.nextCheck), lte(dealerships.nextCheck, now))))
    .orderBy(dealerships.nextCheck)
    .limit(BATCH);
  // A scan that keeps crashing never sets nextCheck; don't re-queue it more than once a day.
  const recentScan = await lastRunAt("website-scan", due.map((d) => d.id));
  for (const d of due) {
    if ((recentScan.get(d.id)?.getTime() ?? 0) > now.getTime() - 86_400_000) continue;
    if ((await enqueue("website-scan", { dealershipId: d.id })).queued) counts["website-scan"]! += 1;
  }

  // Lighter recurring jobs for rooftops that have been scanned at least once.
  const scanned = await db()
    .select({ id: dealerships.id })
    .from(dealerships)
    .where(and(eq(dealerships.paused, false), isNotNull(dealerships.website), isNotNull(dealerships.lastChecked)));
  const ids = scanned.map((s) => s.id);
  const cadences: [QueueName & ("inventory" | "signals" | "social"), number][] = [
    ["inventory", settings.inventoryScanIntervalDays],
    ["signals", settings.signalScanIntervalDays],
    ["social", settings.socialScanIntervalDays],
  ];
  for (const [queue, days] of cadences) {
    const last = await lastRunAt(queue, ids);
    const cutoff = now.getTime() - days * 86_400_000;
    // A full website scan also reads inventory and careers, so it counts as a run of those too.
    const scanLast = queue === "social" ? new Map<string, Date>() : await lastRunAt("website-scan", ids);
    const stale = ids.filter((id) => Math.max(last.get(id)?.getTime() ?? 0, scanLast.get(id)?.getTime() ?? 0) < cutoff).slice(0, BATCH);
    for (const id of stale) if ((await enqueue(queue, { dealershipId: id })).queued) counts[queue]! += 1;
  }

  }

  // Reply monitoring runs around the clock: a dealership answering at 23:30 is still recorded.
  // Safety net: any monitored interaction without a pending check gets one (e.g. after a Redis flush).
  const monitoring = await db().select({ id: testInteractions.id, dealershipId: testInteractions.dealershipId }).from(testInteractions).where(eq(testInteractions.status, "MONITORING"));
  for (const m of monitoring) {
    if ((await enqueue("response-check", { interactionId: m.id, dealershipId: m.dealershipId }, { key: "sweep" })).queued) counts["response-check"]! += 1;
  }

  await expireSuppressions();
  const queuedTotal = Object.values(counts).reduce((a, b) => a + b, 0);
  if (queuedTotal > 0) await emit(`Scheduled ${queuedTotal} job(s)`, { agent: "orion", detail: Object.entries(counts).filter(([, n]) => n > 0).map(([q, n]) => `${q} ×${n}`).join(", "), status: "DONE", kind: "task.created" });
  return counts;
}

/** Deletes screenshots and old research rows past their retention period. Runs once a day. */
export async function retentionSweep(): Promise<{ screenshots: number }> {
  const settings = await getSettings();
  const shotCutoff = new Date(Date.now() - settings.screenshotRetentionDays * 86_400_000);
  const old = await db().select().from(evidence).where(lte(evidence.capturedAt, shotCutoff)).orderBy(desc(evidence.capturedAt)).limit(500);
  for (const e of old) {
    await evidenceStore().delete(e.storageKey).catch((err: unknown) => logger.warn({ err: String(err), key: e.storageKey }, "could not delete stored screenshot"));
    await db().delete(evidence).where(eq(evidence.id, e.id));
  }
  const dataCutoff = new Date(Date.now() - settings.evidenceRetentionDays * 86_400_000);
  await db().delete(inventorySnapshots).where(lte(inventorySnapshots.capturedAt, dataCutoff));
  await db().delete(socialObservations).where(lte(socialObservations.observedAt, dataCutoff));
  await db().delete(signals).where(lte(signals.lastSeenAt, dataCutoff));
  await db().delete(jobRuns).where(lte(jobRuns.startedAt, dataCutoff));
  return { screenshots: old.length };
}

export function startScheduler(): () => void {
  let stopped = false;
  let lastSweepDay = "";
  // Prospecting runs on its own short cadence (default every 30 s), read from settings each time.
  let prospectTimer: ReturnType<typeof setTimeout> | undefined;
  const prospectLoop = async () => {
    if (stopped) return;
    let delay = 30_000;
    try {
      const s = await getSettings();
      delay = s.prospectIntervalSeconds * 1000;
      const inWindow = isWithinWindow(new Date(), { enabled: s.researchWindowEnabled, start: s.researchWindowStart, end: s.researchWindowEnd, timezone: s.timezone });
      if (s.prospectingEnabled && (s.prospectingAroundTheClock || inWindow)) {
        const r = await prospectTick();
        if (r.queued) logger.info("prospect screening queued");
      }
    } catch (err) {
      logger.error({ err: (err as Error).message }, "prospect tick failed");
    }
    if (!stopped) prospectTimer = setTimeout(() => void prospectLoop(), delay);
  };
  prospectTimer = setTimeout(() => void prospectLoop(), 15_000);
  const run = async () => {
    if (stopped) return;
    try {
      const counts = await schedulerTick();
      if (Object.values(counts).some((n) => n > 0)) logger.info({ counts }, "scheduler queued jobs");
      const today = new Date().toISOString().slice(0, 10);
      if (today !== lastSweepDay) {
        lastSweepDay = today;
        logger.info(await retentionSweep(), "retention sweep");
      }
    } catch (err) {
      logger.error({ err: (err as Error).message }, "scheduler tick failed");
    }
  };
  const timer = setInterval(() => void run(), TICK_MS);
  setTimeout(() => void run(), 10_000);
  return () => {
    stopped = true;
    clearInterval(timer);
    if (prospectTimer) clearTimeout(prospectTimer);
  };
}
