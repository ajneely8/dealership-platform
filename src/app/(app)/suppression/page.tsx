import { desc, eq } from "drizzle-orm";
import { suppress, unsuppress } from "@/app/actions";
import { A, Badge, Empty, Field, Flash, PageHeader, Panel, fmtDate, label } from "@/components/ui";
import { db } from "@/db";
import { dealerGroups, dealerships, suppressions } from "@/db/schema";
import { SUPPRESSION_REASONS } from "@/domain/constants";
import { hasRole, requireUser } from "@/lib/auth/session";
import { formatPhone } from "@/lib/normalize";

export default async function SuppressionPage({ searchParams }: { searchParams: Promise<{ notice?: string; error?: string }> }) {
  const { notice, error } = await searchParams;
  const user = await requireUser();
  const canOperate = hasRole(user, "OPERATOR");
  const rows = await db()
    .select({ s: suppressions, dealer: dealerships.name, group: dealerGroups.name })
    .from(suppressions)
    .leftJoin(dealerships, eq(dealerships.id, suppressions.dealershipId))
    .leftJoin(dealerGroups, eq(dealerGroups.id, suppressions.groupId))
    .orderBy(desc(suppressions.active), desc(suppressions.createdAt))
    .limit(400);
  const active = rows.filter((r) => r.s.active);

  return (
    <>
      <PageHeader title="Suppression" sub={`${active.length} active rule(s). Checked before every test, at request, at approval and again right before submission.`} />
      <Flash notice={notice} error={error} />
      <div className="grid gap-4 xl:grid-cols-[1fr_330px]">
        <Panel>
          {rows.length === 0 ? (
            <Empty>Nothing is suppressed. Suppress a dealership or group from its page, or a domain or phone number here.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Level</th>
                    <th>Target</th>
                    <th>Reason</th>
                    <th>Note</th>
                    <th>Added</th>
                    <th>Expires</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ s, dealer, group }) => (
                    <tr key={s.id} className={s.active ? "" : "text-faint"}>
                      <td>{s.active ? <Badge tone="bad">Active</Badge> : <Badge>Lifted</Badge>}</td>
                      <td>{label(s.scope)}</td>
                      <td>
                        {s.scope === "DEALERSHIP" && s.dealershipId ? <A href={`/dealerships/${s.dealershipId}`}>{dealer}</A> : null}
                        {s.scope === "GROUP" && s.groupId ? (
                          <>
                            <A href={`/groups/${s.groupId}`}>{group}</A>
                            <div className="text-[12px] text-muted">{s.includeRooftops ? "Includes all rooftops" : "Group record only"}</div>
                          </>
                        ) : null}
                        {s.scope === "DOMAIN" ? <span className="num">{s.domain}</span> : null}
                        {s.scope === "PHONE" ? <span className="num">{formatPhone(s.phone)}</span> : null}
                      </td>
                      <td>{label(s.reason)}</td>
                      <td className="max-w-[240px] text-[12.5px]">{s.note ?? ""}</td>
                      <td className="whitespace-nowrap text-[12px]">
                        {fmtDate(s.createdAt)}
                        <div className="text-muted">{s.createdBy}</div>
                      </td>
                      <td className="whitespace-nowrap text-[12px]">{s.expiresAt ? fmtDate(s.expiresAt) : "Never"}</td>
                      <td>
                        {s.active && canOperate ? (
                          <form action={unsuppress}>
                            <input type="hidden" name="back" value="/suppression" />
                            <input type="hidden" name="id" value={s.id} />
                            <button className="btn btn-sm" type="submit">
                              Lift
                            </button>
                          </form>
                        ) : s.liftedBy ? (
                          <span className="text-[12px]">by {s.liftedBy}</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {canOperate ? (
          <div className="space-y-4">
            {(
              [
                ["DOMAIN", "Suppress a domain", "domain", "dealer.com"],
                ["PHONE", "Suppress a phone number", "phone", "(210) 555-0100"],
              ] as const
            ).map(([scope, title, field, placeholder]) => (
              <Panel key={scope} title={title}>
                <form action={suppress} className="space-y-2 p-3">
                  <input type="hidden" name="back" value="/suppression" />
                  <input type="hidden" name="scope" value={scope} />
                  <Field label={label(field)}>
                    <input className="input" name={field} placeholder={placeholder} required />
                  </Field>
                  <Field label="Reason">
                    <select className="input" name="reason" defaultValue="DO_NOT_CONTACT">
                      {SUPPRESSION_REASONS.map((r) => (
                        <option key={r} value={r}>
                          {label(r)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Expires (optional)">
                    <input className="input" type="date" name="expiresAt" />
                  </Field>
                  <input className="input" name="note" placeholder="Note (optional)" />
                  <button className="btn btn-danger" type="submit">
                    Suppress {field}
                  </button>
                </form>
              </Panel>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}
