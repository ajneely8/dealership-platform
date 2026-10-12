import { desc, eq } from "drizzle-orm";
import { A, Empty, ExternalLink, Field, Flash, PageHeader, Panel, Provenance, fmtDate, label } from "@/components/ui";
import { db } from "@/db";
import { dealerGroups, dealerships, signals } from "@/db/schema";
import { SIGNAL_TYPES, type SignalType } from "@/domain/constants";

export default async function SignalsPage({ searchParams }: { searchParams: Promise<{ type?: string; notice?: string; error?: string }> }) {
  const { type, notice, error } = await searchParams;
  const filter = SIGNAL_TYPES.includes(type as SignalType) ? (type as SignalType) : undefined;
  const rows = await db()
    .select({ s: signals, dealer: dealerships.name, group: dealerGroups.name })
    .from(signals)
    .leftJoin(dealerships, eq(dealerships.id, signals.dealershipId))
    .leftJoin(dealerGroups, eq(dealerGroups.id, signals.groupId))
    .where(filter ? eq(signals.type, filter) : undefined)
    .orderBy(desc(signals.detectedAt))
    .limit(300);

  return (
    <>
      <PageHeader title="Signals" sub="Hiring and business signals. Every one links to where it was seen.">
        <form className="flex items-end gap-2">
          <Field label="Type">
            <select className="input" name="type" defaultValue={filter ?? ""}>
              <option value="">All types</option>
              {SIGNAL_TYPES.map((t) => (
                <option key={t} value={t}>
                  {label(t)}
                </option>
              ))}
            </select>
          </Field>
          <button className="btn" type="submit">
            Filter
          </button>
        </form>
      </PageHeader>
      <Flash notice={notice} error={error} />
      <Panel>
        {rows.length === 0 ? (
          <Empty>
            No signals{filter ? " of this type" : ""} yet. Hiring signals are read from each dealership&apos;s own careers page during scans; other signals can be added by hand, with a source, from a dealership page. External job-board and news connectors are not built in this version.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Detected</th>
                  <th>Type</th>
                  <th>Signal</th>
                  <th>Account</th>
                  <th>Source</th>
                  <th>Evidence</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ s, dealer, group }) => (
                  <tr key={s.id}>
                    <td className="whitespace-nowrap text-[12.5px]">{fmtDate(s.detectedAt)}</td>
                    <td className="whitespace-nowrap">{label(s.type)}</td>
                    <td>
                      {s.title}
                      {s.description ? <div className="text-[12px] text-muted">{s.description}</div> : null}
                    </td>
                    <td>{s.dealershipId ? <A href={`/dealerships/${s.dealershipId}#signals`}>{dealer}</A> : s.groupId ? <A href={`/groups/${s.groupId}`}>{group}</A> : "—"}</td>
                    <td>
                      <ExternalLink href={s.sourceUrl}>{label(s.source)}</ExternalLink>
                    </td>
                    <td>
                      <Provenance kind={s.kind} confidence={s.confidence} />
                    </td>
                    <td className="whitespace-nowrap text-[12px] text-muted">{fmtDate(s.lastSeenAt)}</td>
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
