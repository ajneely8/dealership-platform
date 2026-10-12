import { and, desc, eq, sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import { deleteGroup, saveGroup, suppress } from "@/app/actions";
import { A, Badge, Empty, ExternalLink, Field, Flash, PageHeader, Panel, MetricStrip, PRODUCT_COLOR, ProductTag, ScoreNumber, fmtDate, label } from "@/components/ui";
import { db } from "@/db";
import { dealerGroups, dealerships, suppressions } from "@/db/schema";
import { PRODUCTS, PRODUCT_LABEL, SUPPRESSION_REASONS } from "@/domain/constants";
import { hasRole, requireUser } from "@/lib/auth/session";

export default async function GroupPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string; error?: string }> }) {
  const { id } = await params;
  const { notice, error } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const user = await requireUser();
  const [g] = await db().select().from(dealerGroups).where(eq(dealerGroups.id, id)).limit(1);
  if (!g) notFound();
  const [rooftops, active] = await Promise.all([
    db().select().from(dealerships).where(eq(dealerships.groupId, id)).orderBy(desc(sql`coalesce(${dealerships.priorityOverride}, ${dealerships.priorityScore})`)),
    db().select().from(suppressions).where(and(eq(suppressions.groupId, id), eq(suppressions.active, true))),
  ]);
  const intel = g.intel;
  const back = `/groups/${id}`;
  const canOperate = hasRole(user, "OPERATOR");

  return (
    <>
      <PageHeader
        title={g.name}
        sub={
          <span className="flex flex-wrap gap-x-3">
            {g.headquarters ? <span>{g.headquarters}</span> : null}
            {g.website ? <ExternalLink href={g.website} /> : null}
            {g.brands.length ? <span>{g.brands.join(" · ")}</span> : null}
          </span>
        }
      >
        {active.length ? <Badge tone="bad">Group suppressed · {label(active[0]!.reason)}</Badge> : null}
      </PageHeader>
      <Flash notice={notice} error={error} />

      <MetricStrip
        items={[
          { label: "Group score", value: g.priorityScore, hint: "Rooftop priorities + repeated problems + size" },
          { label: "Rooftops on file", value: rooftops.length, hint: g.storeCount ? `${g.storeCount} stores known` : "Store count not set" },
          { label: "Scanned", value: intel?.scanned ?? 0 },
          { label: "Systemic problems", value: intel?.systemicProblems.length ?? 0 },
          { label: "Hiring signals", value: intel?.hiringSignalCount ?? 0, hint: "Last 60 days" },
        ]}
      />

      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Panel title="Problems repeating across rooftops">
              {!intel || intel.systemicProblems.length === 0 ? (
                <Empty>None yet. A problem is listed when the same finding shows up at two or more rooftops and at least 40% of those scanned.</Empty>
              ) : (
                <ul>
                  {intel.systemicProblems.map((p) => (
                    <li key={p.ruleId} className="grid grid-cols-[1fr_auto] gap-2 border-b border-line-soft px-3 py-2 text-[13px] last:border-b-0">
                      <span>
                        {p.label}
                        <div>
                          <ProductTag product={p.product} />
                        </div>
                      </span>
                      <span className="num text-right">
                        {p.count} of {intel.scanned || intel.rooftops}
                        <div className="text-[11.5px] text-muted">{Math.round(p.share * 100)}%</div>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title="Shared technology">
              {!intel || intel.sharedTechnology.length === 0 ? (
                <Empty>No technology shared by two or more scanned rooftops.</Empty>
              ) : (
                <ul>
                  {intel.sharedTechnology.map((t) => (
                    <li key={t.name} className="flex justify-between border-b border-line-soft px-3 py-1.5 text-[13px] last:border-b-0">
                      <span>
                        {t.name} <span className="text-muted">· {t.category}</span>
                      </span>
                      <span className="num">
                        {t.count} of {intel.scanned}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <Panel title="Average product score across rooftops">
            <div className="space-y-2 p-3">
              {PRODUCTS.map((p) => (
                <div key={p} className="grid grid-cols-[150px_1fr_30px] items-center gap-2 text-[13px]">
                  <span>{PRODUCT_LABEL[p]}</span>
                  <div className="h-2.5 bg-line-soft">
                    <div className="h-full" style={{ width: `${intel?.productAverages[p] ?? 0}%`, background: PRODUCT_COLOR[p] }} />
                  </div>
                  <span className="num text-right">{intel?.productAverages[p] ?? 0}</span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Rooftops">
            {rooftops.length === 0 ? (
              <Empty>No rooftops are linked to this group yet. Set the group when adding or editing a dealership.</Empty>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Priority</th>
                    <th>Dealership</th>
                    <th>Location</th>
                    <th>Product</th>
                    <th className="text-right">Inventory</th>
                    <th>Checked</th>
                  </tr>
                </thead>
                <tbody>
                  {rooftops.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <ScoreNumber score={d.priorityOverride ?? d.priorityScore} />
                      </td>
                      <td>
                        <A href={`/dealerships/${d.id}`}>{d.name}</A> {d.suppressed ? <Badge tone="bad">Suppressed</Badge> : null}
                      </td>
                      <td>{[d.city, d.state].filter(Boolean).join(", ") || "—"}</td>
                      <td>
                        <ProductTag product={d.recommendedProduct} />
                      </td>
                      <td className="num text-right">{d.inventoryCount ?? "—"}</td>
                      <td className="text-[12px] text-muted">{fmtDate(d.lastChecked)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>

        {canOperate ? (
          <div className="space-y-4">
            <Panel title="Group details">
              <form action={saveGroup} className="space-y-2 p-3">
                <input type="hidden" name="back" value={back} />
                <input type="hidden" name="id" value={id} />
                <Field label="Name">
                  <input className="input" name="name" defaultValue={g.name} required />
                </Field>
                <Field label="Website">
                  <input className="input" name="website" defaultValue={g.website ?? ""} />
                </Field>
                <Field label="Headquarters">
                  <input className="input" name="headquarters" defaultValue={g.headquarters ?? ""} />
                </Field>
                <Field label="Known store count">
                  <input className="input" type="number" min={1} name="storeCount" defaultValue={g.storeCount ?? ""} />
                </Field>
                <Field label="Ownership information">
                  <textarea className="input" name="ownershipInformation" rows={3} defaultValue={g.ownershipInformation ?? ""} />
                </Field>
                <button className="btn" type="submit">
                  Save group
                </button>
              </form>
            </Panel>
            <Panel title="Suppress group">
              <form action={suppress} className="space-y-2 p-3">
                <input type="hidden" name="back" value={back} />
                <input type="hidden" name="scope" value="GROUP" />
                <input type="hidden" name="groupId" value={id} />
                <Field label="Reason">
                  <select className="input" name="reason" defaultValue="CUSTOMER">
                    {SUPPRESSION_REASONS.map((r) => (
                      <option key={r} value={r}>
                        {label(r)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Applies to">
                  <select className="input" name="includeRooftops" defaultValue="true">
                    <option value="true">The group and all its rooftops</option>
                    <option value="false">The group record only</option>
                  </select>
                </Field>
                <input className="input" name="note" placeholder="Note (optional)" />
                <button className="btn btn-danger" type="submit">
                  Suppress group
                </button>
              </form>
            </Panel>
            {hasRole(user, "ADMIN") ? (
              <Panel>
                <details className="p-3">
                  <summary className="cursor-pointer text-[12.5px] text-bad">Delete this group…</summary>
                  <form action={deleteGroup} className="mt-2">
                    <input type="hidden" name="back" value={back} />
                    <input type="hidden" name="id" value={id} />
                    <p className="mb-2 text-[12px] text-muted">Rooftops are kept and become ungrouped.</p>
                    <button className="btn btn-danger" type="submit">
                      Delete group
                    </button>
                  </form>
                </details>
              </Panel>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
