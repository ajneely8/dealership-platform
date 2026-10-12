import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { db } from "@/db";
import { aiCache } from "@/db/schema";
import { getSettings } from "@/lib/settings";
import { currentJobUsage, estimateCostUsd } from "@/lib/job-context";
import { AnthropicProvider } from "./anthropic";

export type AIRequest<T> = {
  /** Stable task name; part of the cache key. */
  task: string;
  system: string;
  /** Structured input only — never raw HTML. Serialised as JSON for the model. */
  input: unknown;
  schema: z.ZodType<T>;
  effort: "low" | "medium" | "high";
  maxTokens: number;
};

export type AIResult<T> = { data: T; inputTokens: number; outputTokens: number; cached: boolean; provider: string; model: string };

/** Implement this to add another model vendor; nothing outside src/ai knows which one is in use. */
export interface AIProvider {
  readonly name: string;
  readonly model: string;
  generate<T>(req: AIRequest<T>): Promise<{ data: T; inputTokens: number; outputTokens: number }>;
}

export class AIUnavailableError extends Error {}
export class AIBudgetError extends Error {}

/** Per-job spend limiter (maxAIRequestsPerJob / maxAITokensPerJob). */
export class AIBudget {
  requests = 0;
  tokens = 0;
  constructor(
    readonly maxRequests: number,
    readonly maxTokens: number,
  ) {}
  assertCanSpend(): void {
    if (this.requests >= this.maxRequests) throw new AIBudgetError(`AI request budget for this job is used up (${this.maxRequests}).`);
    if (this.tokens >= this.maxTokens) throw new AIBudgetError(`AI token budget for this job is used up (${this.maxTokens}).`);
  }
}

export async function resolveProvider(): Promise<AIProvider | null> {
  const settings = await getSettings();
  const provider = settings.aiProvider === "env" ? (process.env.AI_PROVIDER ?? "none") : settings.aiProvider;
  const model = settings.aiModel || process.env.AI_MODEL || "claude-opus-5-5";
  if (provider === "anthropic") return new AnthropicProvider(model);
  return null;
}

/**
 * Runs an AI task with caching and budget enforcement. Identical (task, model, input) is answered
 * from ai_cache without a network call, so re-scoring unchanged evidence costs nothing.
 */
export async function runAI<T>(req: AIRequest<T>, budget: AIBudget): Promise<AIResult<T>> {
  const provider = await resolveProvider();
  if (!provider) throw new AIUnavailableError("No AI provider is configured.");

  const hash = createHash("sha256")
    .update(JSON.stringify([req.task, provider.name, provider.model, req.system, req.input]))
    .digest("hex");
  const [hit] = await db().select().from(aiCache).where(eq(aiCache.hash, hash)).limit(1);
  if (hit) {
    const parsed = req.schema.safeParse(hit.result);
    if (parsed.success) return { data: parsed.data, inputTokens: 0, outputTokens: 0, cached: true, provider: hit.provider, model: hit.model };
  }

  budget.assertCanSpend();
  const out = await provider.generate(req);
  budget.requests += 1;
  budget.tokens += out.inputTokens + out.outputTokens;
  const usage = currentJobUsage();
  if (usage) {
    usage.aiRequests += 1;
    usage.aiInputTokens += out.inputTokens;
    usage.aiOutputTokens += out.outputTokens;
    usage.aiCostUsd += estimateCostUsd(provider.model, out.inputTokens, out.outputTokens);
  }
  await db()
    .insert(aiCache)
    .values({ hash, task: req.task, provider: provider.name, model: provider.model, result: out.data, inputTokens: out.inputTokens, outputTokens: out.outputTokens })
    .onConflictDoNothing();
  return { ...out, cached: false, provider: provider.name, model: provider.model };
}
