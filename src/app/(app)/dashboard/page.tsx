import { and, count, desc, eq, gte, inArray } from "drizzle-orm";
import { CheckRow, FitBadge } from "@/components/checks";
import { A, Empty, PageHeader, Panel, ScoreNumber, fmtDate, timeAgo } from "@/components/ui";
import { db } from "@/db";
import { dealerships, jobRuns, signals, testInteractions } from "@/db/schema";
import { ACTIVE_INTERACTION_STATUSES } from "@/domain/constants";
import type { FitTier } from "@/domain/checks";
import { listOpportunities } from "@/lib/queries";
import { getSettings } from "@/lib/settings";
import { describeWindow, isWithinWindow } from "@/domain/research-window";

export default async function DashboardPage() {
  const [rows, [active], [total], recentSignals, [failures], [lastScan], settings] = await Promise.all([
    listOpportunities({}, 25),
    db().select({ n: count() }).from(testInteractions).where(inArray(testInteractions.status, [...ACTIVE_INTERACTION_STATUSES])),
    db().select({ n: count() }).from(dealerships),
    db().select({ s: signals, dealer: dealerships.name }).from(signals).leftJoin(dealerships, eq(dealerships.id, signals.dealershipId)).orderBy(desc(signals.detectedAt)).limit(5),
    db().select({ n: count() }).from(jobRuns).where(and(eq(jobRuns.status, "FAILED"), gte(jobRuns.startedAt, new Date(Date.now() - 86_400_000)))),
    db().select({ at: jobRuns.completedAt }).from(jobRuns).where(and(eq(jobRuns.queue, "website-scan"), eq(jobRuns.status, "COMPLETED"))).orderBy(desc(jobRuns.completedAt)).limit(1),
    getSettings(),
  ]);
  const windowCfg = { enabled: settings.researchWindowEnabled, start: settings.researchWindowStart, end: settings.researchWindowEnd, timezone: settings.timezone };
  const researching = isWithinWindow(new Date(), windowCfg);
  const order: Record<FitTier, number> = { STRONG: 0, POSSIBLE: 1, UNKNOWN: 2, WEAK: 3 };
  rows.sort((a, b) => order[a.fit.tier] - order[b.fit.tier] || b.priority - a.priority);
  const unchecked = rows.filter((r) => r.checks.receptionist.answer === "UNKNOWN").length;
  const untested = rows.filter((r) => r.checks.followUp.source !== "LIVE_TEST").length;

  return (
    <>
      <PageHeader title="Dealership overview" sub={`${total?.n ?? 0} dealerships · ${active?.n ?? 0} live test(s) running · last scan ${lastScan?.at ? timeAgo(lastScan.at) : "never"} · ${describeWindow(windowCfg)} · ${researching ? "research is on now" : "research paused until the window opens"}`}>
        <a className="btn" href="/api/export/daily-list">
          Download today&apos;s list (CSV)
        </a>
        {(failures?.n ?? 0) > 0 ? (
          <A href="/jobs?status=FAILED" className="text-bad">
            {failures?.n} job failure(s) in 24h
          </A>
        ) : null}
      </PageHeader>

      <Panel title="Dealerships, best fit first" action={<A href="/dealerships">Add a dealership</A>}>
        {rows.length === 0 ? (
          <Empty>
            No dealerships yet. <A href="/dealerships">Add one</A> and it is scanned automatically.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Fit</th>
                  <th>Dealership</th>
                  <th>Chatbot · AI receptionist · Lead follow-up</th>
                  <th>Next step</th>
                  <th className="text-right">Score</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => {
                  const next =
                    o.checks.receptionist.answer === "UNKNOWN" && o.phone
                      ? `Call ${o.phone} and record what answers`
                      : o.checks.followUp.source !== "LIVE_TEST"
                        ? "Run a live lead test"
                        : (o.nextAction ?? "—");
                  return (
                    <tr key={o.id}>
                      <td className="min-w-[200px]">
                        <FitBadge fit={o.fit} />
                      </td>
                      <td className="min-w-[200px]">
                        <A href={`/dealerships/${o.id}`} className="text-[14px] text-text">
                          {o.name}
                        </A>
                        <div className="text-[12px] text-muted">
                          {[o.city, o.state].filter(Boolean).join(", ")}
                          {o.inventoryCount ? ` · ${o.inventoryCount} vehicles` : ""}
                          {o.lastChecked ? ` · scanned ${fmtDate(o.lastChecked)}` : " · not scanned"}
                        </div>
                      </td>
                      <td className="min-w-[300px]">
                        <CheckRow checks={o.checks} />
                      </td>
                      <td className="min-w-[220px] text-[13px]">{next}</td>
                      <td className="text-right">
                        <ScoreNumber score={o.priority} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {rows.length ? (
          <p className="border-t border-line px-4 py-2 text-[12px] text-muted">
            {unchecked} of {rows.length} still need a phone check · {untested} of {rows.length} have not had a live lead test
          </p>
        ) : null}
      </Panel>

      {recentSignals.length ? (
        <Panel title="Recent hiring signals" className="mt-4" action={<A href="/signals">All signals</A>}>
          <ul>
            {recentSignals.map(({ s, dealer }) => (
              <li key={s.id} className="flex flex-wrap items-baseline gap-x-3 border-b border-line-soft px-4 py-2 text-[13px] last:border-b-0">
                <span className="font-medium">{s.title}</span>
                {s.dealershipId ? <A href={`/dealerships/${s.dealershipId}`}>{dealer}</A> : null}
                <span className="text-[12px] text-muted">{timeAgo(s.detectedAt)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </>
  );
}
