import { desc, ilike } from "drizzle-orm";
import { Empty, PageHeader, Panel, fmtDate } from "@/components/ui";
import { db } from "@/db";
import { auditLogs } from "@/db/schema";

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ action?: string }> }) {
  const { action } = await searchParams;
  const term = action?.trim();
  const rows = await db()
    .select()
    .from(auditLogs)
    .where(term ? ilike(auditLogs.action, `%${term}%`) : undefined)
    .orderBy(desc(auditLogs.timestamp))
    .limit(300);
  return (
    <>
      <PageHeader title="Audit log" sub="Tests, suppression, scores, identities and settings: who did what, and when.">
        <form className="flex gap-2">
          <input className="input w-56" name="action" defaultValue={term} placeholder="Filter by action, e.g. test." />
          <button className="btn" type="submit">
            Filter
          </button>
        </form>
      </PageHeader>
      <Panel>
        {rows.length === 0 ? (
          <Empty>No audit entries{term ? " match" : " yet"}.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="num whitespace-nowrap text-[12.5px]">{fmtDate(r.timestamp, true)}</td>
                    <td className="text-[12.5px]">{r.actor}</td>
                    <td className="num text-[12.5px]">{r.action}</td>
                    <td className="num text-[12px] text-muted">
                      {r.entity}
                      {r.entityId ? ` ${r.entityId.slice(0, 8)}` : ""}
                    </td>
                    <td className="num max-w-[520px] break-words text-[11.5px] text-muted">{Object.keys(r.metadata).length ? JSON.stringify(r.metadata) : ""}</td>
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
