import { count, desc, eq } from "drizzle-orm";
import { saveGroup } from "@/app/actions";
import { A, Empty, Field, Flash, PageHeader, Panel, ScoreNumber } from "@/components/ui";
import { db } from "@/db";
import { dealerGroups, dealerships } from "@/db/schema";

export default async function GroupsPage({ searchParams }: { searchParams: Promise<{ notice?: string; error?: string }> }) {
  const { notice, error } = await searchParams;
  const rows = await db()
    .select({ g: dealerGroups, rooftops: count(dealerships.id) })
    .from(dealerGroups)
    .leftJoin(dealerships, eq(dealerships.groupId, dealerGroups.id))
    .groupBy(dealerGroups.id)
    .orderBy(desc(dealerGroups.priorityScore), dealerGroups.name);

  return (
    <>
      <PageHeader title="Dealer Groups" sub="Problems that repeat across a group's rooftops are worth more: one sale can cover many stores." />
      <Flash notice={notice} error={error} />
      <div className="grid gap-4 xl:grid-cols-[1fr_330px]">
        <Panel>
          {rows.length === 0 ? (
            <Empty>No groups yet. Add one here, or include a &quot;group&quot; column when importing dealerships.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Group score</th>
                    <th>Group</th>
                    <th className="text-right">Rooftops on file</th>
                    <th className="text-right">Known stores</th>
                    <th>Shared technology</th>
                    <th>Systemic problems</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ g, rooftops }) => (
                    <tr key={g.id}>
                      <td>
                        <ScoreNumber score={g.priorityScore} />
                      </td>
                      <td>
                        <A href={`/groups/${g.id}`}>{g.name}</A>
                        <div className="text-[12px] text-muted">{g.headquarters ?? ""}</div>
                      </td>
                      <td className="num text-right">{rooftops}</td>
                      <td className="num text-right">{g.storeCount ?? "—"}</td>
                      <td className="text-[12.5px]">
                        {g.intel?.sharedTechnology.slice(0, 3).map((t) => `${t.name} (${t.count})`).join(", ") || "—"}
                      </td>
                      <td className="text-[12.5px]">
                        {g.intel?.systemicProblems.slice(0, 2).map((p) => `${p.label} (${p.count})`).join("; ") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
        <Panel title="Add a group">
          <form action={saveGroup} className="space-y-2 p-3">
            <input type="hidden" name="back" value="/groups" />
            <Field label="Name">
              <input className="input" name="name" required />
            </Field>
            <Field label="Website">
              <input className="input" name="website" />
            </Field>
            <Field label="Headquarters">
              <input className="input" name="headquarters" />
            </Field>
            <Field label="Known store count">
              <input className="input" type="number" min={1} name="storeCount" />
            </Field>
            <Field label="Ownership information">
              <textarea className="input" name="ownershipInformation" rows={2} />
            </Field>
            <button className="btn btn-primary" type="submit">
              Add group
            </button>
          </form>
        </Panel>
      </div>
    </>
  );
}
