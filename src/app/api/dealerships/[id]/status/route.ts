import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { jobRuns } from "@/db/schema";
import { QUEUES, type QueueName } from "@/domain/constants";
import { getSessionUser } from "@/lib/auth/session";
import { getQueue } from "@/queue";

export const dynamic = "force-dynamic";

const LABEL: Record<QueueName, string> = {
  prospect: "Screening the website",
  "phone-check": "Calling the dealership",
  discovery: "Reading the website",
  "website-scan": "Scanning the website",
  inventory: "Counting inventory",
  estimate: "Estimating monthly sales",
  signals: "Checking the careers page",
  social: "Checking social profiles",
  scoring: "Scoring",
  "sales-intel": "Writing the brief",
  interaction: "Submitting the lead test",
  "response-check": "Checking for replies",
};

/** Live work status for one dealership: what is running or about to run, and the last thing that finished. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getSessionUser())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "Not found" }, { status: 404 });

  const active: { queue: QueueName; state: string; label: string }[] = [];
  for (const q of QUEUES) {
    const job = await getQueue(q).getJob(`${q}_${id}`);
    if (!job) continue;
    const state = await job.getState();
    if (state === "waiting" || state === "active" || state === "delayed" || state === "prioritized") active.push({ queue: q, state, label: LABEL[q] });
  }
  const [running] = await db()
    .select({ queue: jobRuns.queue, startedAt: jobRuns.startedAt })
    .from(jobRuns)
    .where(and(eq(jobRuns.dealershipId, id), eq(jobRuns.status, "RUNNING"), gte(jobRuns.startedAt, new Date(Date.now() - 15 * 60_000))))
    .orderBy(desc(jobRuns.startedAt))
    .limit(1);
  const [last] = await db()
    .select({ queue: jobRuns.queue, status: jobRuns.status, result: jobRuns.result, error: jobRuns.error, completedAt: jobRuns.completedAt })
    .from(jobRuns)
    .where(and(eq(jobRuns.dealershipId, id), eq(jobRuns.queue, "website-scan")))
    .orderBy(desc(jobRuns.startedAt))
    .limit(1);

  return Response.json({
    busy: active.length > 0 || Boolean(running),
    current: running ? { label: LABEL[running.queue as QueueName] ?? running.queue, startedAt: running.startedAt } : active[0] ? { label: active[0].state === "active" ? active[0].label : `${active[0].label} (starting)`, startedAt: null } : null,
    pending: active.map((a) => a.label),
    lastScan: last ? { status: last.status, summary: last.error ?? last.result, completedAt: last.completedAt } : null,
  });
}
