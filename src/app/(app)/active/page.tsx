import { and, desc, eq, inArray } from "drizzle-orm";
import { Elapsed } from "@/components/agent-ui";
import { A, Badge, Empty, PageHeader, Panel, fmtDate, label } from "@/components/ui";
import { db } from "@/db";
import { dealerships, jobRuns, testInteractions } from "@/db/schema";
import { AGENTS, agentForQueue } from "@/domain/agents";
import { QUEUES } from "@/domain/constants";
import { getQueue } from "@/queue";

export default async function ActiveResearchPage() {
  const [running, monitoring, pending, counts] = await Promise.all([
    db().select({ r: jobRuns, name: dealerships.name }).from(jobRuns).leftJoin(dealerships, eq(dealerships.id, jobRuns.dealershipId)).where(eq(jobRuns.status, "RUNNING")).orderBy(desc(jobRuns.startedAt)),
    db().select({ i: testInteractions, name: dealerships.name }).from(testInteractions).innerJoin(dealerships, eq(dealerships.id, testInteractions.dealershipId)).where(eq(testInteractions.status, "MONITORING")).orderBy(desc(testInteractions.submittedAt)),
    db().select({ i: testInteractions, name: dealerships.name }).from(testInteractions).innerJoin(dealerships, eq(dealerships.id, testInteractions.dealershipId)).where(inArray(testInteractions.status, ["PENDING_APPROVAL", "APPROVED"])).orderBy(desc(testInteractions.createdAt)),
    Promise.all(
      QUEUES.map(async (q) => {
        const queue = getQueue(q);
        const [c, paused, delayed] = await Promise.all([queue.getJobCounts("waiting", "active", "delayed", "failed"), queue.isPaused(), queue.getDelayed(0, 0)]);
        const next = delayed[0] ? new Date(delayed[0].timestamp + (delayed[0].delay ?? 0)) : null;
        return { q, waiting: c.waiting ?? 0, active: c.active ?? 0, delayed: c.delayed ?? 0, failed: c.failed ?? 0, paused, next };
      }),
    ),
  ]);
  const queuedTotal = counts.reduce((a, c) => a + c.waiting, 0);
  const parkedTotal = counts.reduce((a, c) => a + c.delayed, 0);

  return (
    <>
      <PageHeader title="Active Research" sub={`${running.length} running · ${queuedTotal} queued · ${parkedTotal} parked for research hours · ${monitoring.length} test(s) awaiting replies`} />

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Running now">
          {running.length === 0 ? (
            <Empty>Nothing is running at this moment.</Empty>
          ) : (
            <ul>
              {running.map(({ r, name }) => {
                const a = AGENTS[agentForQueue(r.queue as (typeof QUEUES)[number])];
                return (
                  <li key={r.id} className="flex flex-wrap items-center gap-3 border-b border-line-soft px-4 py-2 text-[13px] last:border-b-0">
                    <A href={`/agents/${a.key}`} className="font-medium" >
                      <span style={{ color: a.color }}>{a.name}</span>
                    </A>
                    <span className="num text-[12px] text-muted">{r.queue}</span>
                    {r.dealershipId ? <A href={`/dealerships/${r.dealershipId}`}>{name}</A> : null}
                    <Elapsed since={r.startedAt} className="ml-auto text-muted" />
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="Awaiting dealership responses" action={<A href="/agents/echo">Echo</A>}>
          {monitoring.length === 0 ? (
            <Empty>No live tests are open.</Empty>
          ) : (
            <ul>
              {monitoring.map(({ i, name }) => (
                <li key={i.id} className="flex flex-wrap items-center gap-3 border-b border-line-soft px-4 py-2 text-[13px] last:border-b-0">
                  <A href={`/dealerships/${i.dealershipId}#interactions`}>{name}</A>
                  <span className="text-muted">{i.testType === "CHAT" ? "Chat" : `${label(i.formType ?? "form")} form`} · submitted {fmtDate(i.submittedAt, true)}</span>
                  {i.firstResponseSeconds !== null ? <Badge tone="good">Replied</Badge> : <Badge tone="warn">Awaiting response</Badge>}
                  {i.submittedAt ? <Elapsed since={i.submittedAt} className="ml-auto text-[14px] text-warn" /> : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Tests waiting to go" action={<A href="/interactions">Approvals</A>}>
          {pending.length === 0 ? (
            <Empty>No tests waiting for approval or dispatch.</Empty>
          ) : (
            <ul>
              {pending.map(({ i, name }) => (
                <li key={i.id} className="flex flex-wrap items-center gap-3 border-b border-line-soft px-4 py-2 text-[13px] last:border-b-0">
                  <A href={`/dealerships/${i.dealershipId}#interactions`}>{name}</A>
                  <span className="text-muted">{i.testType === "CHAT" ? "Chat" : "Form"} test</span>
                  <Badge tone={i.status === "PENDING_APPROVAL" ? "warn" : "blue"}>{label(i.status)}</Badge>
                  <span className="ml-auto text-[12px] text-muted">requested by {i.requestedBy}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Queues">
          <table className="tbl">
            <thead>
              <tr>
                <th>Queue</th>
                <th>Agent</th>
                <th className="text-right">Queued</th>
                <th className="text-right">Running</th>
                <th className="text-right">Parked</th>
                <th className="text-right">Failed</th>
                <th>Next parked job</th>
              </tr>
            </thead>
            <tbody>
              {counts.map((c) => {
                const a = AGENTS[agentForQueue(c.q)];
                return (
                  <tr key={c.q}>
                    <td className="num">
                      {c.q} {c.paused ? <Badge tone="warn">Paused</Badge> : null}
                    </td>
                    <td>
                      <A href={`/agents/${a.key}`}>{a.name}</A>
                    </td>
                    <td className="num text-right">{c.waiting}</td>
                    <td className="num text-right">{c.active}</td>
                    <td className="num text-right">{c.delayed}</td>
                    <td className={`num text-right ${c.failed ? "text-bad" : ""}`}>{c.failed}</td>
                    <td className="whitespace-nowrap text-[12px] text-muted">{c.next ? fmtDate(c.next, true) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      </div>
    </>
  );
}
