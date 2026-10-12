import { and, avg, count, desc, eq, gte, inArray, sql, sum } from "drizzle-orm";
import { db } from "@/db";
import { agentEvents, auditLogs, dealerships, jobRuns, suppressions, testInteractions } from "@/db/schema";
import { AGENTS, AGENT_KEYS, deriveAgentStatus, type AgentKey, type AgentStatus } from "@/domain/agents";
import { QUEUES, type QueueName } from "@/domain/constants";
import { getQueue } from "@/queue";

export type AgentCurrent = { jobRunId: string; queue: string; dealershipId: string | null; dealershipName: string | null; startedAt: Date; lastStep: string | null };

export type AgentLive = {
  key: AgentKey;
  status: AgentStatus;
  paused: boolean;
  running: number;
  queued: number;
  parked: number;
  /** Echo: tests being monitored. Sentinel: tests waiting for a person's approval. */
  waiting: number;
  current: AgentCurrent | null;
  nextScheduled: Date | null;
  lastOutcome: "COMPLETED" | "FAILED" | "SKIPPED" | null;
  lastAt: Date | null;
  stats7d: { completed: number; failed: number; skipped: number; avgMs: number | null; aiRequests: number; aiCostUsd: number };
};

export type AgentEvent = typeof agentEvents.$inferSelect & { dealershipName: string | null };

const queuesOf = (key: AgentKey): readonly QueueName[] => (key === "orion" ? QUEUES : AGENTS[key].queues);

async function queueFacts(queues: readonly QueueName[]) {
  let paused = false;
  let queued = 0;
  let parked = 0;
  let nextScheduled: Date | null = null;
  for (const q of queues) {
    const queue = getQueue(q);
    const [isPaused, counts, delayed] = await Promise.all([queue.isPaused(), queue.getJobCounts("waiting", "delayed", "prioritized"), queue.getDelayed(0, 0)]);
    paused ||= isPaused;
    queued += (counts.waiting ?? 0) + (counts.prioritized ?? 0);
    parked += counts.delayed ?? 0;
    const first = delayed[0];
    if (first) {
      const at = new Date(first.timestamp + (first.delay ?? 0));
      if (!nextScheduled || at < nextScheduled) nextScheduled = at;
    }
  }
  return { paused, queued, parked, nextScheduled };
}

/**
 * Live state of one agent, read from queues, job runs and tests — never guessed.
 * Orion watches every queue but runs no jobs of its own; Sentinel runs only rules. Both take
 * their "last outcome" from their own events rather than from job runs.
 */
export async function agentLive(key: AgentKey, now = new Date()): Promise<AgentLive> {
  const watched = queuesOf(key);
  const queues = AGENTS[key].queues;
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const recent = new Date(now.getTime() - 15 * 60_000);

  const [q, running, last, stats, waitingRow] = await Promise.all([
    watched.length ? queueFacts(watched) : Promise.resolve({ paused: false, queued: 0, parked: 0, nextScheduled: null as Date | null }),
    queues.length
      ? db()
          .select({ id: jobRuns.id, queue: jobRuns.queue, dealershipId: jobRuns.dealershipId, startedAt: jobRuns.startedAt, dealershipName: dealerships.name })
          .from(jobRuns)
          .leftJoin(dealerships, eq(dealerships.id, jobRuns.dealershipId))
          .where(and(inArray(jobRuns.queue, [...queues]), eq(jobRuns.status, "RUNNING"), gte(jobRuns.startedAt, recent)))
          .orderBy(desc(jobRuns.startedAt))
      : Promise.resolve([]),
    queues.length
      ? db()
          .select({ status: jobRuns.status, at: jobRuns.completedAt })
          .from(jobRuns)
          .where(and(inArray(jobRuns.queue, [...queues]), inArray(jobRuns.status, ["COMPLETED", "FAILED", "SKIPPED"])))
          .orderBy(desc(jobRuns.startedAt))
          .limit(1)
      : Promise.resolve([]),
    queues.length
      ? db()
          .select({
            completed: sql<number>`count(*) filter (where ${jobRuns.status} = 'COMPLETED')`,
            failed: sql<number>`count(*) filter (where ${jobRuns.status} = 'FAILED')`,
            skipped: sql<number>`count(*) filter (where ${jobRuns.status} = 'SKIPPED')`,
            avgMs: avg(jobRuns.durationMs),
            aiRequests: sum(jobRuns.aiRequests),
            aiCost: sum(jobRuns.aiCostUsd),
          })
          .from(jobRuns)
          .where(and(inArray(jobRuns.queue, [...queues]), gte(jobRuns.startedAt, since)))
      : Promise.resolve([]),
    key === "echo"
      ? db().select({ n: count() }).from(testInteractions).where(eq(testInteractions.status, "MONITORING"))
      : Promise.resolve([{ n: 0 }]),
  ]);

  let lastStep: string | null = null;
  const cur = running[0];
  if (cur) {
    const [ev] = await db().select({ step: agentEvents.step }).from(agentEvents).where(eq(agentEvents.jobRunId, cur.id)).orderBy(desc(agentEvents.at)).limit(1);
    lastStep = ev?.step ?? null;
  }

  let lastOutcome = (last[0]?.status as AgentLive["lastOutcome"]) ?? null;
  let lastAt = last[0]?.at ?? null;
  if (key === "orion") {
    const [ev] = await db().select({ at: agentEvents.at }).from(agentEvents).where(eq(agentEvents.agent, key)).orderBy(desc(agentEvents.at)).limit(1);
    lastOutcome = ev ? "COMPLETED" : null;
    lastAt = ev?.at ?? null;
  }

  const s = stats[0];
  const waiting = Number(waitingRow[0]?.n ?? 0);
  return {
    key,
    status: deriveAgentStatus({ paused: q.paused, running: running.length, waitingReplies: key === "echo" ? waiting : 0, queued: q.queued + q.parked, lastOutcome, lastAt, now }),
    paused: q.paused,
    running: running.length,
    queued: q.queued,
    parked: q.parked,
    waiting,
    current: cur ? { jobRunId: cur.id, queue: cur.queue, dealershipId: cur.dealershipId, dealershipName: cur.dealershipName, startedAt: cur.startedAt, lastStep } : null,
    nextScheduled: q.nextScheduled,
    lastOutcome,
    lastAt,
    stats7d: {
      completed: Number(s?.completed ?? 0),
      failed: Number(s?.failed ?? 0),
      skipped: Number(s?.skipped ?? 0),
      avgMs: s?.avgMs ? Number(s.avgMs) : null,
      aiRequests: Number(s?.aiRequests ?? 0),
      aiCostUsd: Number(s?.aiCost ?? 0),
    },
  };
}

export async function allAgentsLive(): Promise<AgentLive[]> {
  const now = new Date();
  return Promise.all(AGENT_KEYS.map((k) => agentLive(k, now)));
}

export async function agentEventsFor(opts: { agent?: AgentKey; dealershipId?: string; jobRunId?: string; limit?: number; after?: Date }): Promise<AgentEvent[]> {
  const where = [
    opts.agent ? eq(agentEvents.agent, opts.agent) : undefined,
    opts.dealershipId ? eq(agentEvents.dealershipId, opts.dealershipId) : undefined,
    opts.jobRunId ? eq(agentEvents.jobRunId, opts.jobRunId) : undefined,
    opts.after ? gte(agentEvents.at, opts.after) : undefined,
  ].filter(Boolean);
  const rows = await db()
    .select({ e: agentEvents, dealershipName: dealerships.name })
    .from(agentEvents)
    .leftJoin(dealerships, eq(dealerships.id, agentEvents.dealershipId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(agentEvents.at))
    .limit(opts.limit ?? 50);
  return rows.map((r) => ({ ...r.e, dealershipName: r.dealershipName }));
}

export async function agentHistory(key: AgentKey, limit = 30) {
  const queues = queuesOf(key);
  if (!queues.length) return [];
  return db()
    .select({ id: jobRuns.id, queue: jobRuns.queue, status: jobRuns.status, startedAt: jobRuns.startedAt, completedAt: jobRuns.completedAt, durationMs: jobRuns.durationMs, result: jobRuns.result, error: jobRuns.error, aiCostUsd: jobRuns.aiCostUsd, dealershipId: jobRuns.dealershipId, dealershipName: dealerships.name })
    .from(jobRuns)
    .leftJoin(dealerships, eq(dealerships.id, jobRuns.dealershipId))
    .where(inArray(jobRuns.queue, [...queues]))
    .orderBy(desc(jobRuns.startedAt))
    .limit(limit);
}

/** Numbers for the command center's top strip. */
export async function commandMetrics(now = new Date()) {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const [[total], [researchedToday], [runningJobs], [completedToday], [failed24h], [awaiting], [highPriority], [newOpps], [suppressed], [pending], [policyEvents]] = await Promise.all([
    db().select({ n: count() }).from(dealerships),
    db().select({ n: sql<number>`count(distinct ${jobRuns.dealershipId})` }).from(jobRuns).where(and(eq(jobRuns.queue, "website-scan"), eq(jobRuns.status, "COMPLETED"), gte(jobRuns.startedAt, startOfDay))),
    db().select({ n: count() }).from(jobRuns).where(eq(jobRuns.status, "RUNNING")),
    db().select({ n: count() }).from(jobRuns).where(and(eq(jobRuns.status, "COMPLETED"), gte(jobRuns.startedAt, startOfDay))),
    db().select({ n: count() }).from(jobRuns).where(and(eq(jobRuns.status, "FAILED"), gte(jobRuns.startedAt, dayAgo))),
    db().select({ n: count() }).from(testInteractions).where(eq(testInteractions.status, "MONITORING")),
    db().select({ n: count() }).from(dealerships).where(and(gte(dealerships.priorityScore, 70), eq(dealerships.suppressed, false))),
    db().select({ n: count() }).from(dealerships).where(and(eq(dealerships.pipelineStage, "READY_TO_CONTACT"), gte(dealerships.updatedAt, dayAgo))),
    db().select({ n: count() }).from(suppressions).where(eq(suppressions.active, true)),
    db().select({ n: count() }).from(testInteractions).where(eq(testInteractions.status, "PENDING_APPROVAL")),
    db().select({ n: count() }).from(auditLogs).where(gte(auditLogs.timestamp, dayAgo)),
  ]);
  return {
    dealerships: Number(total?.n ?? 0),
    researchedToday: Number(researchedToday?.n ?? 0),
    runningJobs: Number(runningJobs?.n ?? 0),
    completedToday: Number(completedToday?.n ?? 0),
    failed24h: Number(failed24h?.n ?? 0),
    awaitingResponses: Number(awaiting?.n ?? 0),
    highPriority: Number(highPriority?.n ?? 0),
    newOpportunities: Number(newOpps?.n ?? 0),
    suppressed: Number(suppressed?.n ?? 0),
    pendingApprovals: Number(pending?.n ?? 0),
    auditEvents24h: Number(policyEvents?.n ?? 0),
  };
}

/** One finished (or running) task, for replay. */
export async function jobRunById(id: string) {
  const [row] = await db()
    .select({ id: jobRuns.id, queue: jobRuns.queue, status: jobRuns.status, startedAt: jobRuns.startedAt, completedAt: jobRuns.completedAt, dealershipId: jobRuns.dealershipId, dealershipName: dealerships.name, result: jobRuns.result, error: jobRuns.error })
    .from(jobRuns)
    .leftJoin(dealerships, eq(dealerships.id, jobRuns.dealershipId))
    .where(eq(jobRuns.id, id))
    .limit(1);
  return row ?? null;
}

/** Shape the stream and pages hand to the browser. */
export function toSnapshot(a: AgentLive) {
  return { key: a.key, status: a.status, waiting: a.waiting, queued: a.queued + a.parked, current: a.current ? { ...a.current, startedAt: a.current.startedAt.toISOString() } : null };
}
export function toFeed(e: AgentEvent) {
  return { ...e, at: e.at.toISOString() };
}
