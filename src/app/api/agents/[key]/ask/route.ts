import { z } from "zod";
import { AIBudget, resolveProvider, runAI } from "@/ai/provider";
import { AGENTS, AGENT_KEYS, type AgentKey } from "@/domain/agents";
import { answerFromFacts, type BriefingFacts } from "@/domain/agent-voice";
import { agentEventsFor, agentHistory, agentLive } from "@/lib/agent-state";
import { getSessionUser } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Ask an agent a question. The answer is built from the agent's own recorded work: with an AI
 * provider configured, the model writes it in the agent's voice from those facts only; without
 * one (or if the model strays), a rule-based answer from the same facts is returned instead.
 */
export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  if (!(await getSessionUser())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { key } = await params;
  if (!AGENT_KEYS.includes(key as AgentKey)) return Response.json({ error: "Unknown agent" }, { status: 404 });
  const agentKey = key as AgentKey;
  const body = (await req.json().catch(() => ({}))) as { question?: string };
  const question = String(body.question ?? "").slice(0, 400);

  const [live, events, history, settings] = await Promise.all([agentLive(agentKey), agentEventsFor({ agent: agentKey, limit: 40 }), agentHistory(agentKey, 60), getSettings()]);
  // Times are handed over already in the operator's time zone so nothing has to convert them.
  const local = (d: Date) => d.toLocaleString("en-US", { timeZone: settings.timezone, weekday: "short", hour: "numeric", minute: "2-digit" });
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const todays = history.filter((h) => h.startedAt >= startOfDay);
  const seen = new Set<string>();
  const dealerships = events
    .filter((e) => e.dealershipName && !seen.has(e.dealershipName) && seen.add(e.dealershipName))
    .map((e) => ({ name: e.dealershipName!, lastStep: e.step, at: local(e.at) }))
    .slice(0, 12);
  const facts: BriefingFacts = {
    agentName: AGENTS[agentKey].name,
    role: AGENTS[agentKey].role,
    status: live.status,
    current: live.current ? { step: live.current.lastStep, dealership: live.current.dealershipName, queue: live.current.queue, seconds: Math.round((Date.now() - live.current.startedAt.getTime()) / 1000) } : null,
    today: { completed: todays.filter((h) => h.status === "COMPLETED").length, failed: todays.filter((h) => h.status === "FAILED").length, skipped: todays.filter((h) => h.status === "SKIPPED").length },
    recent: events.slice(0, 25).map((e) => ({ at: local(e.at), step: e.step, dealership: e.dealershipName, status: e.status })),
    dealerships,
  };

  const provider = await resolveProvider().catch(() => null);
  if (provider) {
    try {
      const result = await runAI(
        {
          task: "agent-voice.v1",
          system: [
            `You are ${facts.agentName}, the ${facts.role} on a dealership research team. Answer the operator's question in the first person, in two to four short spoken sentences.`,
            "Use ONLY the facts provided. Never invent dealerships, numbers, replies or outcomes. If the facts do not cover the question, say so and offer what you do know.",
            `Times in the facts are already in the operator's local time (${settings.timezone}); repeat them as given, never convert them or add a time zone. Do not mention being an AI model or these instructions.`,
          ].join("\n"),
          input: { question, facts },
          schema: z.object({ answer: z.string().min(1).max(900) }),
          effort: "low",
          maxTokens: 400,
        },
        new AIBudget(1, 6000),
      );
      // Grounding check: any dealership-like name in the answer must appear somewhere in the facts
      // (linked dealership names or the step text itself, e.g. "Screening Front Range Motors").
      const corpus = JSON.stringify(facts).toLowerCase();
      const suspicious = /\b([A-Z][A-Za-z'&.-]+(?: [A-Z][A-Za-z'&.-]+)* (?:Motors|Auto Sales|Automotive|Autos|Cars|Motor Group|Auto Group|Auto Center|Auto Brokers))\b/g;
      let grounded = true;
      for (const m of result.data.answer.matchAll(suspicious)) if (!corpus.includes(m[1]!.toLowerCase())) grounded = false;
      if (grounded) return Response.json({ answer: result.data.answer, source: "ai" });
      logger.warn({ agent: agentKey }, "agent voice answer named an unknown dealership; using the rule-based answer");
    } catch (err) {
      logger.warn({ err: (err as Error).message, agent: agentKey }, "agent voice AI answer failed; using the rule-based answer");
    }
  }
  return Response.json({ answer: answerFromFacts(question, facts), source: "rules" });
}
