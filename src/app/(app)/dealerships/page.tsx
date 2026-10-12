import { createDealership, importDealerships } from "@/app/actions";
import { A, Badge, Empty, Field, Flash, PageHeader, Panel, ScoreNumber, fmtDate } from "@/components/ui";
import { CheckRow, SalesStatusBadge } from "@/components/checks";
import { db } from "@/db";
import { dealerGroups } from "@/db/schema";
import { listOpportunities } from "@/lib/queries";

export default async function DealershipsPage({ searchParams }: { searchParams: Promise<{ q?: string; notice?: string; error?: string }> }) {
  const { q, notice, error } = await searchParams;
  const term = q?.trim();
  const [all, groups] = await Promise.all([
    listOpportunities({ suppression: "all" }, 2000),
    db().select({ id: dealerGroups.id, name: dealerGroups.name }).from(dealerGroups).orderBy(dealerGroups.name),
  ]);
  const needle = term?.toLowerCase();
  const rows = needle ? all.filter((o) => [o.name, o.domain, o.city].some((v) => v?.toLowerCase().includes(needle))) : all;

  return (
    <>
      <PageHeader title="Dealerships" sub="Individual rooftops. Groups are managed separately.">
        <form className="flex gap-2">
          <input className="input w-56" name="q" defaultValue={term} placeholder="Search name, domain or city" />
          <button className="btn" type="submit">
            Search
          </button>
        </form>
      </PageHeader>
      <Flash notice={notice} error={error} />

      <div className="grid gap-4 xl:grid-cols-[1fr_330px]">
        <Panel>
          {rows.length === 0 ? (
            <Empty>{term ? `No dealerships match "${term}".` : "No dealerships yet. Add one or import a CSV to start researching."}</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Priority</th>
                    <th>Dealership</th>
                    <th>Group</th>
                    <th>Location</th>
                    <th>Chatbot · AI receptionist · Lead follow-up</th>
                    <th className="text-right">Inventory</th>
                    <th>Sales</th>
                    <th>Last checked</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <ScoreNumber score={d.priority} />
                      </td>
                      <td>
                        <A href={`/dealerships/${d.id}`}>{d.name}</A>
                        <div className="text-[12px] text-muted">{d.domain ?? "No website"}</div>
                        <div className="mt-0.5 flex gap-1">
                          {d.suppressed ? <Badge tone="bad">Suppressed</Badge> : null}
                          {d.paused ? <Badge tone="warn">Paused</Badge> : null}
                        </div>
                      </td>
                      <td>{d.groupId ? <A href={`/groups/${d.groupId}`}>{d.groupName}</A> : <span className="text-faint">—</span>}</td>
                      <td>{[d.city, d.state].filter(Boolean).join(", ") || "—"}</td>
                      <td className="min-w-[320px]">
                        <CheckRow checks={d.checks} />
                      </td>
                      <td className="num text-right">{d.inventoryCount ?? "—"}</td>
                      <td className="min-w-[150px]">
                        <SalesStatusBadge status={d.salesStatus} at={d.lastTouchAt} />
                      </td>
                      <td className="whitespace-nowrap text-[12px] text-muted">{fmtDate(d.lastChecked)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <div className="space-y-4">
          <Panel title="Add a dealership">
            <form action={createDealership} className="space-y-2 p-3">
              <input type="hidden" name="back" value="/dealerships" />
              <Field label="Website" hint="The name, address and phone are read from the site.">
                <input className="input" name="website" placeholder="dealer.com" />
              </Field>
              <Field label="Name" hint="Optional. Only needed when there is no website.">
                <input className="input" name="name" />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Phone">
                  <input className="input" name="phone" />
                </Field>
                <Field label="Brands" hint="Comma separated">
                  <input className="input" name="brands" />
                </Field>
              </div>
              <Field label="Street address">
                <input className="input" name="address" />
              </Field>
              <div className="grid grid-cols-[1fr_56px_80px] gap-2">
                <Field label="City">
                  <input className="input" name="city" />
                </Field>
                <Field label="State">
                  <input className="input" name="state" maxLength={2} />
                </Field>
                <Field label="ZIP">
                  <input className="input" name="zip" />
                </Field>
              </div>
              <Field label="Dealer group">
                <select className="input" name="groupId" defaultValue="">
                  <option value="">None</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </Field>
              <button className="btn btn-primary" type="submit">
                Add dealership
              </button>
            </form>
          </Panel>

          <Panel title="Import from CSV">
            <form action={importDealerships} className="space-y-2 p-3">
              <input type="hidden" name="back" value="/dealerships" />
              <p className="text-[12.5px] text-muted">
                Columns: <span className="num">website</span> or <span className="num">name</span> (one is required), plus optional <span className="num">phone, address, city, state, zip, brands, group</span>. Duplicates are skipped and listed.
              </p>
              <input className="input" type="file" name="file" accept=".csv,text/csv" required />
              <button className="btn" type="submit">
                Import CSV
              </button>
            </form>
          </Panel>
        </div>
      </div>
    </>
  );
}
