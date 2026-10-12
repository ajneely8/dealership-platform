import { Queue, type JobsOptions } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { QUEUES, type QueueName } from "@/domain/constants";

const globalForQueue = globalThis as unknown as { __diRedis?: Redis; __diQueues?: Map<QueueName, Queue> };

/** Shared connection for producers (web app). Workers create their own blocking connections. */
export function redis(): Redis {
  if (!globalForQueue.__diRedis) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is not set");
    globalForQueue.__diRedis = new IORedis(url, { maxRetriesPerRequest: null });
  }
  return globalForQueue.__diRedis;
}

export function newWorkerConnection(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set");
  return new IORedis(url, { maxRetriesPerRequest: null });
}

/** Per-queue retry/timeout policy. Timeouts are enforced by the job runner (BullMQ has no built-in one). */
export const QUEUE_POLICY: Record<QueueName, { attempts: number; backoffMs: number; timeoutMs: number }> = {
  prospect: { attempts: 1, backoffMs: 0, timeoutMs: 2 * 60_000 },
  // One phone call, never repeated automatically.
  "phone-check": { attempts: 1, backoffMs: 0, timeoutMs: 8 * 60_000 },
  discovery: { attempts: 3, backoffMs: 30_000, timeoutMs: 90_000 },
  "website-scan": { attempts: 3, backoffMs: 60_000, timeoutMs: 6 * 60_000 },
  inventory: { attempts: 3, backoffMs: 60_000, timeoutMs: 4 * 60_000 },
  signals: { attempts: 3, backoffMs: 60_000, timeoutMs: 3 * 60_000 },
  social: { attempts: 2, backoffMs: 60_000, timeoutMs: 2 * 60_000 },
  scoring: { attempts: 3, backoffMs: 5_000, timeoutMs: 30_000 },
  "sales-intel": { attempts: 3, backoffMs: 15_000, timeoutMs: 90_000 },
  // Arithmetic over stored snapshots: quick, no browser.
  estimate: { attempts: 2, backoffMs: 5_000, timeoutMs: 30_000 },
  // A form submission must never be repeated automatically: one attempt, no retry.
  interaction: { attempts: 1, backoffMs: 0, timeoutMs: 3 * 60_000 },
  "response-check": { attempts: 5, backoffMs: 10_000, timeoutMs: 30_000 },
};

export function getQueue(name: QueueName): Queue {
  globalForQueue.__diQueues ??= new Map();
  let q = globalForQueue.__diQueues.get(name);
  if (!q) {
    const p = QUEUE_POLICY[name];
    q = new Queue(name, {
      connection: redis(),
      defaultJobOptions: {
        attempts: p.attempts,
        backoff: { type: "exponential", delay: p.backoffMs },
        removeOnComplete: true,
        // Failed jobs are kept so an operator can inspect and retry them.
        removeOnFail: { count: 1000 },
      },
    });
    globalForQueue.__diQueues.set(name, q);
  }
  return q;
}

type BasePayloads = {
  prospect: { prospectId: string; dealershipId?: undefined };
  "phone-check": { dealershipId: string };
  discovery: { dealershipId: string };
  "website-scan": { dealershipId: string };
  inventory: { dealershipId: string };
  signals: { dealershipId: string };
  social: { dealershipId: string };
  scoring: { dealershipId: string };
  "sales-intel": { dealershipId: string };
  estimate: { dealershipId: string };
  interaction: { interactionId: string; dealershipId: string };
  "response-check": { interactionId: string; dealershipId: string };
};
/** `manual: true` marks work an operator asked for; it runs even outside the research window. */
export type JobPayloads = { [K in keyof BasePayloads]: BasePayloads[K] & { manual?: boolean } };

export type EnqueueResult = { queued: boolean; jobId: string; reason?: string };

/**
 * Adds a job with a deterministic id so the same work is never queued twice.
 * If a finished (failed) job with that id is still on record it is replaced; if one is
 * waiting/active the call is a no-op.
 */
export async function enqueue<Q extends QueueName>(
  name: Q,
  payload: JobPayloads[Q],
  opts: { key?: string; delayMs?: number } = {},
): Promise<EnqueueResult> {
  const queue = getQueue(name);
  const subject = "interactionId" in payload ? payload.interactionId : "prospectId" in payload ? payload.prospectId : payload.dealershipId;
  const jobId = `${name}_${subject}${opts.key ? `_${opts.key}` : ""}`;
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "failed" || state === "completed") await existing.remove();
    else return { queued: false, jobId, reason: `already ${state}` };
  }
  const jobOpts: JobsOptions = { jobId, delay: opts.delayMs };
  await queue.add(name, payload, jobOpts);
  return { queued: true, jobId };
}

export async function closeQueues(): Promise<void> {
  for (const q of globalForQueue.__diQueues?.values() ?? []) await q.close();
  globalForQueue.__diQueues = undefined;
  await globalForQueue.__diRedis?.quit().catch(() => undefined);
  globalForQueue.__diRedis = undefined;
}

export { QUEUES };
