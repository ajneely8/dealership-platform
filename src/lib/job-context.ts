import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentKey } from "@/domain/agents";

/** Per-job context: which agent and job this is, plus the AI usage it accumulates. */
export type JobUsage = {
  agent?: AgentKey;
  jobRunId?: string | null;
  dealershipId?: string | null;
  aiRequests: number;
  aiInputTokens: number;
  aiOutputTokens: number;
  aiCostUsd: number;
  /** Tear-downs (open browsers, mostly) run when the job is cut off by its timeout, so nothing keeps running in the background. */
  cleanups: Set<() => Promise<void>>;
};

const storage = new AsyncLocalStorage<JobUsage>();

export function createJobUsage(ctx: Pick<JobUsage, "agent" | "jobRunId" | "dealershipId"> = {}): JobUsage {
  return { ...ctx, aiRequests: 0, aiInputTokens: 0, aiOutputTokens: 0, aiCostUsd: 0, cleanups: new Set() };
}

export function runWithJobUsage<T>(fn: () => Promise<T>, ctx: Pick<JobUsage, "agent" | "jobRunId" | "dealershipId"> | JobUsage = {}): Promise<{ result: T; usage: JobUsage }> {
  const usage: JobUsage = "cleanups" in ctx ? ctx : createJobUsage(ctx);
  return storage.run(usage, async () => ({ result: await fn(), usage }));
}

/** Registers a tear-down for the current job; returns a function that unregisters it (call it on a normal close). */
export function registerJobCleanup(fn: () => Promise<void>): () => void {
  const usage = storage.getStore();
  if (!usage) return () => undefined;
  usage.cleanups.add(fn);
  return () => usage.cleanups.delete(fn);
}

/** Runs and clears every tear-down registered by a job that was cut off. */
export async function runJobCleanups(usage: JobUsage): Promise<number> {
  const fns = [...usage.cleanups];
  usage.cleanups.clear();
  for (const fn of fns) await fn().catch(() => undefined);
  return fns.length;
}

export function currentJobUsage(): JobUsage | undefined {
  return storage.getStore();
}

/** List price per million tokens (input, output). Unknown models fall back to the Opus rate. */
const PRICE_PER_MTOK: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
  "claude-haiku-4-5-20251001": [1, 5],
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const [inRate, outRate] = PRICE_PER_MTOK[model] ?? [4, 20];
  return (inputTokens * inRate + outputTokens * outRate) / 1_000_000;
}
