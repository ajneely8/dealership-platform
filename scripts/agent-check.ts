/**
 * Agent check: run ONE agent's task against ONE dealership and watch it step by step.
 *
 *   npm run agent-check -- <queue> <dealershipId|domain>
 *   npm run agent-check -- scheduler            (Orion: one scheduler tick)
 *   npm run agent-check -- status               (every agent's live status)
 *
 * Queues: discovery · website-scan · inventory · signals · social · scoring · sales-intel
 * (interaction and response-check are driven from the app, behind approval).
 *
 * Needs the dev stack running (npm run fast / dev). Uses the same database and queue, so
 * the step list printed here is exactly what the agent's Live activity tab shows.
 */
import { and, desc, eq, gte, ilike, or } from "drizzle-orm";
import { db } from "@/db";
import { agentEvents, dealerships } from "@/db/schema";
import { AGENTS, agentForQueue } from "@/domain/agents";
import { QUEUES, type QueueName } from "@/domain/constants";
import { allAgentsLive } from "@/lib/agent-state";
import { closeQueues, enqueue } from "@/queue";
import { schedulerTick } from "@/workers/scheduler";

const RESEARCH: QueueName[] = ["prospect", "phone-check", "discovery", "website-scan", "inventory", "signals", "social", "scoring", "sales-intel"];

async function main() {
  const [what, target] = process.argv.slice(2);
  if (what === "status") {
    for (const a of await allAgentsLive()) console.log(`${AGENTS[a.key].number} ${AGENTS[a.key].name.padEnd(9)} ${a.status.padEnd(10)} running=${a.running} queued=${a.queued} parked=${a.parked} waiting=${a.waiting} last=${a.lastOutcome ?? "—"} ${a.lastAt?.toISOString() ?? ""}`);
    return;
  }
  if (what === "events") {
    const agent = (target ?? "nova") as keyof typeof AGENTS;
    const n = Number(process.argv[4] ?? 30);
    const rows = await db().select().from(agentEvents).where(eq(agentEvents.agent, agent)).orderBy(desc(agentEvents.at)).limit(n);
    for (const e of rows.reverse()) console.log(`${e.at.toISOString().slice(5, 19)}  ${e.status.padEnd(7)} ${e.kind.padEnd(20)} ${e.step}${e.detail ? `  — ${e.detail.slice(0, 110)}` : ""}`);
    return;
  }
  if (what === "park" || what === "unpark") {
    const { getQueue } = await import("@/queue");
    if (what === "unpark") {
      let n = 0;
      for (const q of QUEUES) for (const j of await getQueue(q).getDelayed()) { await j.remove(); n += 1; }
      console.log(`removed ${n} parked job(s)`);
      return;
    }
    const [d] = await db().select({ id: dealerships.id, name: dealerships.name }).from(dealerships).where(ilike(dealerships.website, `%${process.argv[4] ?? target}%`)).limit(1);
    if (!d) throw new Error("no dealership");
    const since = new Date();
    const r = await enqueue((target ?? "inventory") as QueueName, { dealershipId: d.id }); // not manual → subject to research hours
    console.log(`enqueued ${target} for ${d.name} as a scheduled job: ${r.queued ? "queued" : r.reason}`);
    await new Promise((res) => setTimeout(res, 4000));
    await printEvents({ agent: "orion", since });
    const delayed = await getQueue((target ?? "inventory") as QueueName).getDelayed();
    for (const j of delayed) console.log(`parked: ${j.name} resumes ${new Date(j.timestamp + (j.delay ?? 0)).toISOString()}`);
    return;
  }
  if (what === "relay") {
    // Who has the baton right now; "relay release" hands it back so Nova can screen the next candidate.
    const { currentRelay, relayFinish, RELAY_STAGES } = await import("@/workers/relay");
    const r = await currentRelay();
    if (!r) console.log("No dealership is mid-relay; Nova is free to screen the next candidate.");
    else console.log(`${AGENTS[r.stage].name} has ${r.name} (stage ${RELAY_STAGES.indexOf(r.stage) + 1} of ${RELAY_STAGES.length}) since ${r.stageAt} — ${r.note}`);
    if (r && target === "release") {
      await relayFinish(r.dealershipId, "orion", "released by an operator");
      console.log("Released.");
    }
    return;
  }
  if (what === "scheduler") {
    const since = new Date();
    const counts = await schedulerTick();
    console.log("Orion tick:", counts);
    await printEvents({ agent: "orion", since });
    return;
  }
  if (!what || !RESEARCH.includes(what as QueueName) || !target) {
    console.error(`usage: agent-check <${RESEARCH.join("|")}> <dealershipId|domain> | scheduler | status | relay [release]`);
    process.exit(2);
  }
  const queue = what as QueueName;
  const [d] = await db()
    .select({ id: dealerships.id, name: dealerships.name, website: dealerships.website })
    .from(dealerships)
    .where(or(eq(dealerships.id, /^[0-9a-f-]{36}$/i.test(target) ? target : "00000000-0000-0000-0000-000000000000"), ilike(dealerships.website, `%${target}%`), ilike(dealerships.name, `%${target}%`)))
    .limit(1);
  if (!d) throw new Error(`No dealership matches "${target}"`);
  const agent = agentForQueue(queue);
  console.log(`${AGENTS[agent].number} ${AGENTS[agent].name} · ${queue} · ${d.name} (${d.website ?? "no website"})`);
  const since = new Date();
  const r = await enqueue(queue, { dealershipId: d.id, manual: true });
  if (!r.queued) {
    console.log(`not queued: ${r.reason ?? "already running"}`);
    return;
  }
  // Tail the agent's events for this dealership until the task ends.
  const seen = new Set<string>();
  const started = Date.now();
  let jobRunId: string | null = null;
  for (;;) {
    const rows = await db()
      .select()
      .from(agentEvents)
      .where(and(eq(agentEvents.agent, agent), eq(agentEvents.dealershipId, d.id), gte(agentEvents.at, new Date(since.getTime() - 1000))))
      .orderBy(agentEvents.at);
    let ended = false;
    for (const e of rows) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      if (e.kind === "task.started") jobRunId = e.jobRunId;
      if (jobRunId && e.jobRunId && e.jobRunId !== jobRunId) continue;
      console.log(`${e.at.toISOString().slice(11, 19)}  ${e.status.padEnd(7)} ${e.kind.padEnd(20)} ${e.step}${e.detail ? `  — ${e.detail.slice(0, 120)}` : ""}${e.evidenceId ? `  [evidence ${e.evidenceId}]` : ""}`);
      if (["task.completed", "task.failed", "task.blocked"].includes(e.kind) && e.jobRunId === jobRunId) ended = true;
    }
    if (ended) break;
    if (Date.now() - started > 8 * 60_000) {
      console.log("gave up waiting after 8 minutes");
      break;
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
}

async function printEvents(o: { agent: keyof typeof AGENTS; since: Date }) {
  const rows = await db().select().from(agentEvents).where(and(eq(agentEvents.agent, o.agent), gte(agentEvents.at, o.since))).orderBy(desc(agentEvents.at)).limit(20);
  for (const e of rows.reverse()) console.log(`${e.at.toISOString().slice(11, 19)}  ${e.status.padEnd(7)} ${e.kind.padEnd(20)} ${e.step}${e.detail ? `  — ${e.detail.slice(0, 120)}` : ""}`);
  if (rows.length === 0) console.log("(no events)");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueues().catch(() => undefined);
    setTimeout(() => process.exit(), 200).unref();
  });

void QUEUES;
