import { sql } from "drizzle-orm";
import { A, Empty, PageHeader, Panel } from "@/components/ui";
import { db } from "@/db";
import { INTENT_BAND_LABEL, type IntentBand } from "@/domain/intent";
import { intentMetrics } from "@/domain/intent-run";
import { fmtUsd } from "@/domain/volume";

type Row = { band: IntentBand; dealerships: number; called: number; reached: number; meetings: number; attended: number; proposals: number; won: number; lost: number };

/**
 * Does the score predict sales? Outcomes logged by the sales team, grouped by buying-intent band.
 * Rates are shown only once a band has ten or more dealerships worked; before that the numbers
 * are too few to mean anything, and the page says so instead of pretending.
 */
export default async function ResultsPage() {
  const [metrics, raw] = await Promise.all([
    intentMetrics(),
    db().execute(sql`
      select case when d.buying_intent >= 75 then 'HIGH' when d.buying_intent >= 45 then 'MEDIUM' else 'LOW' end as band,
             count(distinct d.id)::int as dealerships,
             count(distinct d.id) filter (where t.outcome is not null)::int as called,
             count(distinct d.id) filter (where t.outcome in ('DECISION_MAKER_REACHED','INTERESTED','BOOKED_MEETING','MEETING_COMPLETED','PROPOSAL_SENT','SOLD'))::int as reached,
             count(distinct d.id) filter (where t.outcome in ('BOOKED_MEETING','MEETING_COMPLETED','PROPOSAL_SENT','SOLD'))::int as meetings,
             count(distinct d.id) filter (where t.outcome in ('MEETING_COMPLETED','PROPOSAL_SENT','SOLD'))::int as attended,
             count(distinct d.id) filter (where t.outcome in ('PROPOSAL_SENT','SOLD'))::int as proposals,
             count(distinct d.id) filter (where t.outcome = 'SOLD')::int as won,
             count(distinct d.id) filter (where t.outcome = 'NOT_INTERESTED')::int as lost
      from dealerships d left join sales_touches t on t.dealership_id = d.id
      where d.suppressed = false and d.buying_intent is not null
      group by 1 order by case band when 'HIGH' then 0 when 'MEDIUM' then 1 else 2 end`),
  ]);
  const rows = (raw.rows as Row[]).map((r) => ({ ...r, band: r.band as IntentBand }));
  const pct = (n: number, d: number) => (d >= 10 ? `${Math.round((n / d) * 100)}%` : d > 0 ? "too few" : "—");

  return (
    <>
      <PageHeader title="Results by score band" sub="Whether high-scoring dealerships actually convert better. Outcomes come from the Sales log; rates appear once a band has ten or more dealerships worked.">
        <A href="/queue">Call queue</A>
        <A href="/opportunities">All scores</A>
      </PageHeader>
      <Panel className="mb-4">
        <div className="grid gap-px bg-line-soft md:grid-cols-3 xl:grid-cols-6">
          {[
            ["Scored", metrics.scored, "dealerships with a buying-intent score"],
            ["High priority", metrics.high, "75 and above"],
            ["Medium priority", metrics.medium, "45 to 74"],
            ["Confirmed interest", metrics.confirmed, "logged by the sales team"],
            ["Meetings booked", metrics.meetingsBooked, "dealerships"],
            ["Customers closed", metrics.customersClosed, `${fmtUsd(metrics.mrrEarned)} MRR logged`],
          ].map(([k, v, hint]) => (
            <div key={String(k)} className="bg-surface px-4 py-3">
              <div className="eyebrow">{k}</div>
              <div className="num mt-1 text-[22px] font-medium">{v}</div>
              <div className="text-[12px] text-muted">{hint}</div>
            </div>
          ))}
        </div>
        <p className="px-4 py-2 text-[12.5px] text-faint">
          Projected MRR if every high-priority prospect closed at {fmtUsd(metrics.mrrPerLocation)} a location: {fmtUsd(metrics.mrrProjected)}. Projected, not earned; change the price per location in Settings.
        </p>
      </Panel>
      <Panel title="Funnel by band">
        {rows.length === 0 ? (
          <Empty>No scored dealerships yet. Scores appear as Atlas runs.</Empty>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Band</th>
                <th className="text-right">Dealerships</th>
                <th className="text-right">Worked</th>
                <th className="text-right">Decision-maker reached</th>
                <th className="text-right">Meetings booked</th>
                <th className="text-right">Meetings held</th>
                <th className="text-right">Proposals</th>
                <th className="text-right">Closed won</th>
                <th className="text-right">Not interested</th>
                <th className="text-right">Meeting rate</th>
                <th className="text-right">Close rate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.band}>
                  <td>{INTENT_BAND_LABEL[r.band]}</td>
                  <td className="num text-right">{r.dealerships}</td>
                  <td className="num text-right">{r.called}</td>
                  <td className="num text-right">{r.reached}</td>
                  <td className="num text-right">{r.meetings}</td>
                  <td className="num text-right">{r.attended}</td>
                  <td className="num text-right">{r.proposals}</td>
                  <td className="num text-right">{r.won}</td>
                  <td className="num text-right">{r.lost}</td>
                  <td className="num text-right">{pct(r.meetings, r.called)}</td>
                  <td className="num text-right">{pct(r.won, r.called)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="px-4 py-2 text-[12px] text-faint">No model is trained on this; it is a plain count of what happened. When the high band converts better than the low band over enough dealerships, the score is doing its job.</p>
      </Panel>
    </>
  );
}
