import { and, desc, eq } from "drizzle-orm";
import { retryJob } from "@/app/actions";
import { A, Badge, Empty, Flash, PageHeader, Panel, fmtDate } from "@/components/ui";
import { db } from "@/db";
import { dealerships, jobRuns } from "@/db/schema";
import { QUEUES, type QueueName } from "@/domain/constants";
import { hasRole, requireUser } from "@/lib/auth/session";
import { getQueue } from "@/queue";

const STATUSES = ["FAILED", "RUNNING", "SKIPPED", "COMPLETED"] as const;

export default async function JobsPage({ searchParams }: { searchParams: Promise<{ status?: string; queue?: string; notice?: string; error?: string }> }) {
  const p = await searchParams;
  const user = await requireUser();
  const status = STATUSES.find((s) => s === p.status);
  const queue = QUEUES.find((q) => q === p.queue);
  const [rows, counts] = await Promise.all([
    db()
      .select({ r: jobRuns, dealer: dealerships.name })
      .from(jobRuns)
      .leftJoin(dealerships, eq(dealerships.id, jobRuns.dealershipId))
      .where(and(status ? eq(jobRuns.status, status) : undefined, queue ? eq(jobRuns.queue, queue) : undefined))
      .orderBy(desc(jobRuns.startedAt))
      .limit(200),
    // Live queue depth straight from Redis.
    Promise.all(
      QUEUES.map(async (q: QueueName) => {
        const c = await getQueue(q).getJobCounts("waiting", "active", "delayed", "failed");
        return { q, waiting: c.waiting ?? 0, active: c.active ?? 0, delayed: c.delayed ?? 0, failed: c.failed ?? 0 };
      }),
    ),
  ]);

  return (
    <>
      <PageHeader title="Jobs" sub="Every background job run, with duration, result and errors.">
        <form className="flex gap-2">
          <select className="input" name="status" defaultValue={status ?? ""}>
            <option value="">Any status</option>
            {STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <select className="input" name="queue" defaultValue={queue ?? ""}>
            <option value="">Any queue</option>
            {QUEUES.map((q) => (
              <option key={q}>{q}</option>
            ))}
          </select>
          <button className="btn" type="submit">
            Filter
          </button>
        </form>
      </PageHeader>
      <Flash notice={p.notice} error={p.error} />

      <Panel title="Queues right now" className="mb-4">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Queue</th>
                <th className="text-right">Waiting</th>
                <th className="text-right">Active</th>
                <th className="text-right">Scheduled</th>
                <th className="text-right">Failed</th>
              </tr>
            </thead>
            <tbody>
              {counts.map((c) => (
                <tr key={c.q}>
                  <td className="num">{c.q}</td>
                  <td className="num text-right">{c.waiting}</td>
                  <td className="num text-right">{c.active}</td>
                  <td className="num text-right">{c.delayed}</td>
                  <td className={`num text-right ${c.failed ? "text-bad" : ""}`}>{c.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Job runs">
        {rows.length === 0 ? (
          <Empty>No job runs match.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Worker</th>
                  <th>Dealership</th>
                  <th>Status</th>
                  <th className="text-right">Duration</th>
                  <th className="text-right">Retries</th>
                  <th>Result / error</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ r, dealer }) => (
                  <tr key={r.id}>
                    <td className="num whitespace-nowrap text-[12.5px]">{fmtDate(r.startedAt, true)}</td>
                    <td className="num text-[12.5px]">{r.worker}</td>
                    <td>{r.dealershipId && dealer ? <A href={`/dealerships/${r.dealershipId}`}>{dealer}</A> : "—"}</td>
                    <td>
                      <Badge tone={r.status === "FAILED" ? "bad" : r.status === "COMPLETED" ? "good" : r.status === "RUNNING" ? "warn" : "neutral"}>{r.status}</Badge>
                    </td>
                    <td className="num text-right">{r.durationMs !== null ? `${(r.durationMs / 1000).toFixed(1)}s` : "—"}</td>
                    <td className="num text-right">{r.retryCount}</td>
                    <td className={`max-w-[420px] break-words text-[12.5px] ${r.error ? "text-bad" : "text-muted"}`}>{r.error ?? r.result ?? ""}</td>
                    <td>
                      {r.status === "FAILED" && r.queue !== "interaction" && hasRole(user, "OPERATOR") ? (
                        <form action={retryJob}>
                          <input type="hidden" name="back" value="/jobs?status=FAILED" />
                          <input type="hidden" name="id" value={r.id} />
                          <button className="btn btn-sm" type="submit">
                            Retry
                          </button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
