import { and, desc, eq, inArray } from "drizzle-orm";
import { A, Empty, ExternalLink, Field, PageHeader, Panel, fmtDate, label } from "@/components/ui";
import { db } from "@/db";
import { dealerships, evidence, type Evidence } from "@/db/schema";
import { EVIDENCE_TYPES, type EvidenceType } from "@/domain/constants";

const TYPE_ORDER: EvidenceType[] = ["HOMEPAGE", "INVENTORY", "FORM", "SERVICE", "CHAT", "SOCIAL", "RESPONSE", "OTHER"];

/** Evidence is organised one dealership at a time; a dealership's screenshots are grouped by what they show. */
export default async function EvidencePage({ searchParams }: { searchParams: Promise<{ type?: string; dealership?: string }> }) {
  const { type, dealership } = await searchParams;
  const filterType = EVIDENCE_TYPES.includes(type as EvidenceType) ? (type as EvidenceType) : undefined;
  const selected = dealership && /^[0-9a-f-]{36}$/i.test(dealership) ? dealership : undefined;

  const dealers = await db()
    .select({ id: dealerships.id, name: dealerships.name, city: dealerships.city, state: dealerships.state, website: dealerships.website, lastChecked: dealerships.lastChecked })
    .from(dealerships)
    .orderBy(dealerships.name);
  const ids = selected ? [selected] : dealers.map((d) => d.id);
  const rows = ids.length
    ? await db()
        .select()
        .from(evidence)
        .where(and(inArray(evidence.dealershipId, ids), filterType ? eq(evidence.type, filterType) : undefined))
        .orderBy(desc(evidence.capturedAt))
    : [];

  const byDealer = new Map<string, Evidence[]>();
  for (const e of rows) byDealer.set(e.dealershipId, [...(byDealer.get(e.dealershipId) ?? []), e]);
  const shown = dealers.filter((d) => (selected ? d.id === selected : byDealer.has(d.id)));

  return (
    <>
      <PageHeader title="Evidence" sub="Screenshots from each dealership's scans and tests, one dealership at a time.">
        <form className="flex items-end gap-2">
          <Field label="Dealership">
            <select className="input min-w-[220px]" name="dealership" defaultValue={selected ?? ""}>
              <option value="">All dealerships</option>
              {dealers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Type">
            <select className="input" name="type" defaultValue={filterType ?? ""}>
              <option value="">All types</option>
              {EVIDENCE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {label(t)}
                </option>
              ))}
            </select>
          </Field>
          <button className="btn" type="submit">
            Show
          </button>
        </form>
      </PageHeader>

      {shown.length === 0 ? (
        <Panel>
          <Empty>No screenshots yet. They are captured automatically when a website is scanned.</Empty>
        </Panel>
      ) : (
        <div className="space-y-4">
          {shown.map((d) => {
            const items = byDealer.get(d.id) ?? [];
            // Latest capture of each type first; older captures of the same type follow, collapsed.
            const latestByType = new Map<EvidenceType, Evidence>();
            for (const e of items) if (!latestByType.has(e.type)) latestByType.set(e.type, e);
            const latest = TYPE_ORDER.filter((t) => latestByType.has(t)).map((t) => latestByType.get(t)!);
            const older = items.filter((e) => !latest.includes(e));
            return (
              <Panel
                key={d.id}
                title={
                  <span className="flex items-center gap-2 normal-case tracking-normal">
                    <A href={`/dealerships/${d.id}`} className="text-[14px]">
                      {d.name}
                    </A>
                    <span className="text-[12px] font-normal text-muted">
                      {[d.city, d.state].filter(Boolean).join(", ")}
                      {d.lastChecked ? ` · scanned ${fmtDate(d.lastChecked)}` : ""} · {items.length} screenshot{items.length === 1 ? "" : "s"}
                    </span>
                  </span>
                }
                action={selected ? <A href="/evidence">All dealerships</A> : <A href={`/evidence?dealership=${d.id}`}>Only this dealership</A>}
              >
                {items.length === 0 ? (
                  <Empty>No screenshots for this dealership yet.</Empty>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4 xl:grid-cols-5">
                      {latest.map((e) => (
                        <Shot key={e.id} e={e} />
                      ))}
                    </div>
                    {older.length ? (
                      <details className="border-t border-line">
                        <summary className="cursor-pointer px-4 py-2 text-[12.5px] text-muted hover:text-text">
                          {older.length} older screenshot{older.length === 1 ? "" : "s"} from earlier scans
                        </summary>
                        <div className="grid grid-cols-2 gap-3 p-4 pt-0 md:grid-cols-4 xl:grid-cols-5">
                          {older.map((e) => (
                            <Shot key={e.id} e={e} />
                          ))}
                        </div>
                      </details>
                    ) : null}
                  </>
                )}
              </Panel>
            );
          })}
        </div>
      )}
    </>
  );
}

function Shot({ e }: { e: Evidence }) {
  return (
    <figure className="border border-line">
      <a href={`/api/evidence/${e.id}`} target="_blank" rel="noreferrer">
        {/* eslint-disable-next-line @next/next/no-img-element -- authenticated evidence route, not an optimisable public asset */}
        {e.contentType?.startsWith("audio/") ? <audio controls preload="none" src={`/api/evidence/${e.id}`} className="w-full" /> : <img src={`/api/evidence/${e.id}`} alt={`${label(e.type)} screenshot`} loading="lazy" className="aspect-[3/2] w-full object-cover object-top" />}
      </a>
      <figcaption className="space-y-0.5 px-2 py-1.5 text-[12px]">
        <div className="flex justify-between">
          <span className="font-medium">{label(e.type)}</span>
          <span className="num text-muted">{fmtDate(e.capturedAt, true)}</span>
        </div>
        {e.sourceUrl ? (
          <div className="truncate text-muted">
            <ExternalLink href={e.sourceUrl}>{new URL(e.sourceUrl).pathname === "/" ? "Homepage" : new URL(e.sourceUrl).pathname}</ExternalLink>
          </div>
        ) : null}
      </figcaption>
    </figure>
  );
}
