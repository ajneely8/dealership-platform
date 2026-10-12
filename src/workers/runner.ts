import { DelayedError, Worker, type Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { dealerships, jobRuns } from "@/db/schema";
import { RESEARCH_QUEUES, type QueueName } from "@/domain/constants";
import { refreshGroupIntel } from "@/domain/group-intel";
import { runScoring } from "@/domain/scoring/run";
import { env } from "@/env";
import { logger } from "@/lib/logger";
import { createJobUsage, runJobCleanups, runWithJobUsage } from "@/lib/job-context";
import { emit } from "@/lib/agent-events";
import { agentForQueue } from "@/domain/agents";
import { getSettings } from "@/lib/settings";
import { isWithinWindow, nextWindowStart } from "@/domain/research-window";
import { enqueue, newWorkerConnection, QUEUE_POLICY, type JobPayloads } from "@/queue";
import { runChatProbe } from "./interaction/chat-probe";
import { runPhoneCheck } from "./phone-check";
import { demoteIfUnresearchable, rejectProspect, runProspectScreen } from "./prospect";
import { afterAtlas, afterBlaze, afterCharlie, afterHunter, afterNova, afterPhoneCheck, afterSage, afterSentinel, currentRelay, relayFinish, relayFor } from "./relay";
import { storeEstimate } from "./estimate";
import { runFormInteraction } from "./interaction/form-submit";
import { testInteractions } from "@/db/schema";
import { runResponseCheck } from "./response-check";
import { runSalesIntel } from "./sales-intel";
import { runSocialScan } from "./social";
import { runCareersScan, runDiscovery, runInventoryScan, runWebsiteScan } from "./website/scan";

type Handler<Q extends QueueName> = (payload: JobPayloads[Q]) => Promise<string>;

/**
 * One handler per queue. Workers never call each other: each reads and writes the database and,
 * where the pipeline continues, enqueues the next stage.
 */
export const HANDLERS: { [Q in QueueName]: Handler<Q> } = {
  prospect: async ({ prospectId }) => runProspectScreen(prospectId),
  "phone-check": async ({ dealershipId, manual }) => {
    const result = await runPhoneCheck(dealershipId);
    await afterPhoneCheck(dealershipId, manual);
    return result;
  },
  discovery: async ({ dealershipId, manual }) => {
    const result = await runDiscovery(dealershipId);
    if (await demoteIfUnresearchable(dealershipId, result)) return `${result} — removed again (not researchable)`;
    await enqueue("website-scan", { dealershipId, manual });
    return result;
  },
  "website-scan": async ({ dealershipId, manual }) => {
    const result = await runWebsiteScan(dealershipId);
    if (await demoteIfUnresearchable(dealershipId, result)) return `${result} — removed again (not researchable)`;
    await enqueue("scoring", { dealershipId, manual });
    if (await relayFor(dealershipId)) {
      // A dealership found by prospecting runs the relay: Charlie next, then Sage, Hunter, Atlas, Blaze.
      if (/^OK/.test(result)) await afterNova(dealershipId, manual);
      else await relayFinish(dealershipId, "nova", `website scan ended with ${result.split(":")[0]}`);
    } else {
      // Every scan refreshes Sentinel's estimate; a scan an operator asked for also sends Hunter and Sage in now.
      if (/^OK/.test(result)) await enqueue("estimate", { dealershipId, manual });
      if (manual && /^OK/.test(result)) {
        await enqueue("signals", { dealershipId, manual });
        await enqueue("social", { dealershipId, manual });
      }
    }
    return result;
  },
  inventory: async ({ dealershipId, manual }) => {
    const read = await runInventoryScan(dealershipId);
    const est = /^OK/.test(read) ? await storeEstimate(dealershipId) : null;
    await enqueue("scoring", { dealershipId, manual });
    await afterSentinel(dealershipId, manual);
    return est ? `${read} · ${est}` : read;
  },
  estimate: async ({ dealershipId, manual }) => {
    const result = await storeEstimate(dealershipId);
    await afterSentinel(dealershipId, manual);
    return result;
  },
  signals: async ({ dealershipId, manual }) => {
    const result = await runCareersScan(dealershipId);
    await enqueue("scoring", { dealershipId, manual });
    await afterHunter(dealershipId);
    return result;
  },
  social: async ({ dealershipId, manual }) => {
    const result = await runSocialScan(dealershipId);
    await enqueue("scoring", { dealershipId, manual });
    await afterSage(dealershipId, manual);
    return result;
  },
  scoring: async ({ dealershipId, manual }) => {
    const outcome = await runScoring(dealershipId);
    if (!outcome) return "SKIPPED: dealership not found";
    const [d] = await db().select({ groupId: dealerships.groupId }).from(dealerships).where(eq(dealerships.id, dealershipId)).limit(1);
    if (d?.groupId) await refreshGroupIntel(d.groupId);
    await enqueue("sales-intel", { dealershipId, manual });
    await afterAtlas(dealershipId);
    return `OK: priority ${outcome.priority}${outcome.changed ? " (changed)" : ""}`;
  },
  "sales-intel": async ({ dealershipId }) => {
    const result = await runSalesIntel(dealershipId);
    await afterBlaze(dealershipId);
    return result;
  },
  interaction: async ({ interactionId, dealershipId, manual }) => {
    const [i] = await db().select({ testType: testInteractions.testType }).from(testInteractions).where(eq(testInteractions.id, interactionId)).limit(1);
    if (i?.testType !== "CHAT") return runFormInteraction(interactionId);
    const result = await runChatProbe(interactionId);
    await afterCharlie(dealershipId, manual);
    return result;
  },
  "response-check": ({ interactionId }) => runResponseCheck(interactionId),
};

/** Rejects after `ms`; `onTimeout` runs first so the cut-off job tears down whatever it holds (its browser) and stops. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string, onTimeout?: () => Promise<void>): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void (onTimeout?.() ?? Promise.resolve()).finally(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export { RESEARCH_QUEUES };

/**
 * Wraps a handler with the job_runs record: start, finish, duration, status, error, retry count
 * and AI usage. Research jobs that arrive outside the research window are parked until it opens,
 * unless an operator asked for them (`manual`). Inbound replies are never subject to the window.
 */
export async function executeJob<Q extends QueueName>(
  queue: Q,
  job: Pick<Job, "id" | "data" | "attemptsMade"> & { moveToDelayed?: Job["moveToDelayed"] },
  token?: string,
): Promise<string> {
  const payload = job.data as JobPayloads[Q];
  if (RESEARCH_QUEUES.includes(queue) && !payload.manual && job.moveToDelayed && token) {
    const s = await getSettings();
    const cfg = { enabled: s.researchWindowEnabled, start: s.researchWindowStart, end: s.researchWindowEnd, timezone: s.timezone };
    const now = new Date();
    if (!isWithinWindow(now, cfg)) {
      const at = nextWindowStart(now, cfg);
      logger.info({ queue, jobId: job.id, resumeAt: at.toISOString() }, "outside the research window; job parked until it opens");
      await emit(`Parked ${queue} until the research window opens`, { agent: "orion", dealershipId: payload.dealershipId, detail: `Resumes ${at.toISOString()}`, kind: "task.scheduled" });
      if (payload.dealershipId) await relayFinish(payload.dealershipId, "orion", `${queue} parked until research hours; the rest of the research follows when it runs`);
      await job.moveToDelayed(at.getTime(), token);
      throw new DelayedError();
    }
  }
  const started = Date.now();
  const [run] = await db()
    .insert(jobRuns)
    .values({
      jobId: String(job.id),
      queue,
      worker: `${queue}-worker`,
      dealershipId: payload.dealershipId,
      payload: payload as Record<string, unknown>,
      status: "RUNNING",
      retryCount: job.attemptsMade,
    })
    .returning({ id: jobRuns.id });
  const done = async (status: string, fields: { result?: string; error?: string; aiRequests?: number; aiInputTokens?: number; aiOutputTokens?: number; aiCostUsd?: number }) => {
    if (!run) return;
    // The record must close even when the pool is busy: try twice, and never let this throw —
    // a job whose row stays RUNNING looks like an agent frozen mid-task.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await db()
          .update(jobRuns)
          .set({ status, completedAt: new Date(), durationMs: Date.now() - started, ...fields })
          .where(eq(jobRuns.id, run.id));
        return;
      } catch (err) {
        logger.warn({ queue, jobRunId: run.id, attempt, err: (err as Error).message }, "could not close the job record");
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };
  await emit(`${queue} started`, { agent: agentForQueue(queue), jobRunId: run?.id ?? null, dealershipId: payload.dealershipId, kind: "task.started", detail: payload.manual ? "requested by an operator" : "scheduled" });
  try {
    const agent = agentForQueue(queue);
    const ctx = { agent, jobRunId: run?.id ?? null, dealershipId: payload.dealershipId };
    const jobUsage = createJobUsage(ctx);
    const { result, usage } = await withTimeout(runWithJobUsage(() => HANDLERS[queue](payload), jobUsage), QUEUE_POLICY[queue].timeoutMs, `${queue} job`, async () => {
      const n = await runJobCleanups(jobUsage);
      if (n) logger.warn({ queue, jobId: job.id, closed: n }, "job cut off by its timeout; its browser was closed");
    });
    const skipped = /^(SKIPPED|BLOCKED|ROBOTS_DISALLOWED)/.test(result);
    const { aiRequests, aiInputTokens, aiOutputTokens, aiCostUsd } = usage;
    await done(skipped ? "SKIPPED" : "COMPLETED", { result: result.slice(0, 2000), aiRequests, aiInputTokens, aiOutputTokens, aiCostUsd });
    await emit(skipped ? `${queue} skipped` : `${queue} finished in ${Math.round((Date.now() - started) / 1000)}s`, { ...ctx, detail: result.slice(0, 300), status: skipped ? "BLOCKED" : "DONE", kind: skipped ? "task.blocked" : "task.completed" });
    logger.info({ queue, jobId: job.id, dealershipId: payload.dealershipId, durationMs: Date.now() - started, result }, "job completed");
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ queue, jobId: job.id, dealershipId: payload.dealershipId, attempt: job.attemptsMade + 1, err: message }, "job failed");
    await done("FAILED", { error: message.slice(0, 4000) });
    await emit(`${queue} failed`, { agent: agentForQueue(queue), jobRunId: run?.id ?? null, dealershipId: payload.dealershipId, detail: message.slice(0, 300), status: "ERROR", kind: "task.failed" });
    const lastAttempt = job.attemptsMade + 1 >= QUEUE_POLICY[queue].attempts;
    if (payload.dealershipId && lastAttempt) await relayFinish(payload.dealershipId, agentForQueue(queue), `${queue} failed: ${message.slice(0, 120)}`).catch(() => undefined);
    // A screening that ran out of time is a site too slow to research: turn it away rather than send it round again.
    if (queue === "prospect" && "prospectId" in payload && /timed out/.test(message)) await rejectProspect(payload.prospectId, "the website took too long to load (over two minutes)").catch(() => undefined);
    throw err; // let BullMQ apply retry/backoff
  }
}

const BROWSER_QUEUES: QueueName[] = ["prospect", "discovery", "website-scan", "inventory", "signals", "interaction"];

export function startWorkers(): Worker[] {
  const concurrency = env().WORKER_CONCURRENCY;
  // Anything still marked RUNNING belongs to a worker that no longer exists (a restart): close it
  // honestly so no agent is shown as working on a task that died.
  void db()
    .update(jobRuns)
    .set({ status: "FAILED", error: "Interrupted by a worker restart", completedAt: new Date() })
    .where(eq(jobRuns.status, "RUNNING"))
    .then(() => undefined)
    .catch((err: Error) => logger.warn({ err: err.message }, "could not close interrupted job runs"));
  void currentRelay()
    .then((r) => (r ? relayFinish(r.dealershipId, "orion", "interrupted by a worker restart") : undefined))
    .catch((err: Error) => logger.warn({ err: err.message }, "could not release the relay"));
  return (Object.keys(HANDLERS) as QueueName[]).map(
    (queue) =>
      new Worker(queue, (job, token) => executeJob(queue, job, token), {
        connection: newWorkerConnection(),
        // Browser jobs are heavy; interactions run strictly one at a time.
        concurrency: queue === "interaction" ? 1 : BROWSER_QUEUES.includes(queue) ? concurrency : Math.max(concurrency, 4),
        lockDuration: QUEUE_POLICY[queue].timeoutMs + 30_000,
      }),
  );
}
