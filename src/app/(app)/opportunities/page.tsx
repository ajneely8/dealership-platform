import { CheckRow, FitBadge, SalesStatusBadge } from "@/components/checks";
import { fmtUsd } from "@/domain/volume";
import { A, Badge, Empty, Field, PageHeader, Panel, ProductTag, ScoreNumber, fmtDate, label } from "@/components/ui";
import { db } from "@/db";
import { dealerGroups } from "@/db/schema";
import { PRODUCTS, PRODUCT_LABEL, type Product } from "@/domain/constants";
import { formatDuration } from "@/domain/response-timing";
import { listOpportunities, type OpportunityFilters } from "@/lib/queries";

type Params = Record<string, string | undefined>;

export default async function OpportunitiesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const p = await searchParams;
  const filters: OpportunityFilters = {
    state: p.state || undefined,
    city: p.city || undefined,
    brand: p.brand || undefined,
    groupId: p.group || undefined,
    product: PRODUCTS.includes(p.product as Product) ? (p.product as Product) : undefined,
    minScore: p.min ? Number(p.min) || undefined : undefined,
    minInventory: p.inventory ? Number(p.inventory) || undefined : undefined,
    response: (["none", "slow", "fast", "untested"] as const).find((x) => x === p.response),
    tested: (["never", "30d", "older"] as const).find((x) => x === p.tested),
    hiring: p.hiring === "1",
    technology: p.tech || undefined,
    suppression: (["active", "suppressed", "all"] as const).find((x) => x === p.suppression) ?? "active",
  };
  const [rows, groups] = await Promise.all([listOpportunities(filters), db().select({ id: dealerGroups.id, name: dealerGroups.name }).from(dealerGroups).orderBy(dealerGroups.name)]);
  // Strong fits first, then possible fits, then the unknowns and weak ones; highest priority within each.
  const tierOrder = { STRONG: 0, POSSIBLE: 1, UNKNOWN: 2, WEAK: 3 } as const;
  rows.sort((a, b) => tierOrder[a.fit.tier] - tierOrder[b.fit.tier] || b.priority - a.priority);
  const strong = rows.filter((r) => r.fit.tier === "STRONG").length;
  const possible = rows.filter((r) => r.fit.tier === "POSSIBLE").length;
  const filtered = Object.entries(p).some(([k, v]) => v && k !== "notice" && k !== "error");

  return (
    <>
      <PageHeader title="Opportunities" sub={`${rows.length} account(s) · ${strong} strong fit${strong === 1 ? "" : "s"} first, then ${possible} possible fit${possible === 1 ? "" : "s"}, highest priority within each`} />

      <Panel className="mb-3">
        <form className="grid grid-cols-2 gap-2 p-3 md:grid-cols-4 xl:grid-cols-6">
          <Field label="State">
            <input className="input" name="state" defaultValue={p.state} maxLength={2} placeholder="TX" />
          </Field>
          <Field label="City">
            <input className="input" name="city" defaultValue={p.city} />
          </Field>
          <Field label="Brand">
            <input className="input" name="brand" defaultValue={p.brand} placeholder="Ford" />
          </Field>
          <Field label="Dealer group">
            <select className="input" name="group" defaultValue={p.group ?? ""}>
              <option value="">Any</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Product">
            <select className="input" name="product" defaultValue={p.product ?? ""}>
              <option value="">Any</option>
              {PRODUCTS.map((x) => (
                <option key={x} value={x}>
                  {PRODUCT_LABEL[x]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Min priority">
            <input className="input" name="min" type="number" min={0} max={100} defaultValue={p.min} />
          </Field>
          <Field label="Min inventory">
            <input className="input" name="inventory" type="number" min={0} defaultValue={p.inventory} />
          </Field>
          <Field label="Response time">
            <select className="input" name="response" defaultValue={p.response ?? ""}>
              <option value="">Any</option>
              <option value="none">Tested, no response</option>
              <option value="slow">Over 15 minutes</option>
              <option value="fast">15 minutes or less</option>
              <option value="untested">Not tested</option>
            </select>
          </Field>
          <Field label="Last tested">
            <select className="input" name="tested" defaultValue={p.tested ?? ""}>
              <option value="">Any</option>
              <option value="never">Never</option>
              <option value="30d">Last 30 days</option>
              <option value="older">Over 30 days ago</option>
            </select>
          </Field>
          <Field label="Technology">
            <input className="input" name="tech" defaultValue={p.tech} placeholder="Dealer.com" />
          </Field>
          <Field label="Suppression">
            <select className="input" name="suppression" defaultValue={filters.suppression}>
              <option value="active">Not suppressed</option>
              <option value="suppressed">Suppressed only</option>
              <option value="all">All</option>
            </select>
          </Field>
          <div className="flex items-end gap-3">
            <label className="flex items-center gap-1.5 pb-1.5 text-[13px]">
              <input type="checkbox" name="hiring" value="1" defaultChecked={filters.hiring} /> Hiring signal
            </label>
            <button className="btn btn-primary" type="submit">
              Filter
            </button>
            {filtered ? <A href="/opportunities">Clear</A> : null}
          </div>
        </form>
      </Panel>

      <Panel>
        {rows.length === 0 ? (
          <Empty>{filtered ? "No accounts match these filters." : "No dealerships yet. Add or import some on the Dealerships page."}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Priority</th>
                  <th>Dealership</th>
                  <th>Chatbot · AI receptionist · Lead follow-up</th>
                  <th>Fit</th>
                  <th>Best product</th>
                  <th className="text-right">Inventory</th>
                  <th>Sold a month · gross profit (est.)</th>
                  <th>First response</th>
                  <th>Sales</th>
                  <th>Stage</th>
                  <th>Next action</th>
                  <th>Checked</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <ScoreNumber score={o.priority} />
                      {o.overridden ? <span className="ml-1 text-[11px] text-warn" title="Manual priority">M</span> : null}
                    </td>
                    <td className="min-w-[200px]">
                      <A href={`/dealerships/${o.id}`}>{o.name}</A>
                      <div className="text-[12px] text-muted">
                        {[o.city, o.state].filter(Boolean).join(", ")}
                        {o.groupName ? ` · ${o.groupName}` : ""}
                      </div>
                      <div className="mt-0.5 flex gap-1">
                        {o.suppressed ? <Badge tone="bad">Suppressed</Badge> : null}
                        {o.paused ? <Badge tone="warn">Paused</Badge> : null}
                        {o.hiring ? <Badge>Hiring</Badge> : null}
                      </div>
                    </td>
                    <td className="min-w-[320px]">
                      <CheckRow checks={o.checks} />
                    </td>
                    <td className="min-w-[220px]">
                      <FitBadge fit={o.fit} />
                    </td>
                    <td>
                      <ProductTag product={o.recommendedProduct} />
                    </td>
                    <td className="num text-right">{o.inventoryCount ?? "—"}</td>
                    <td className="min-w-[150px] text-[12.5px]">
                      {o.estimate ? (
                        <>
                          <span className="num">{o.estimate.unitsLow}–{o.estimate.unitsHigh}</span> vehicles
                          <div className="text-muted">{o.estimate.profitLow !== null && o.estimate.profitHigh !== null ? `${fmtUsd(o.estimate.profitLow)}–${fmtUsd(o.estimate.profitHigh)} profit` : "no prices read"}</div>
                        </>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap">{o.firstResponseSeconds !== null ? formatDuration(o.firstResponseSeconds) : o.lastTestedAt ? <span className="text-bad">None yet</span> : <span className="text-faint">Not tested</span>}</td>
                    <td className="min-w-[150px]">
                      <SalesStatusBadge status={o.salesStatus} at={o.lastTouchAt} />
                    </td>
                    <td className="whitespace-nowrap">{label(o.pipelineStage)}</td>
                    <td className="min-w-[160px] text-[12.5px]">{o.nextAction ?? "—"}</td>
                    <td className="whitespace-nowrap text-[12px] text-muted">{fmtDate(o.lastChecked)}</td>
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
