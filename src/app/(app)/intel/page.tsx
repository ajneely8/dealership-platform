import { desc, eq, inArray } from "drizzle-orm";
import { CopyButton } from "@/components/agent-ui";
import { CheckRow, FitBadge } from "@/components/checks";
import { A, Empty, PageHeader, Panel, ProductTag, Provenance, ScoreNumber, fmtDate } from "@/components/ui";
import { db } from "@/db";
import { contacts, dealerships, salesBriefs } from "@/db/schema";
import { listOpportunities } from "@/lib/queries";

/** One report per dealership: what to pitch, what to say, and the evidence under every line. */
export default async function SalesIntelligencePage() {
  const rows = await listOpportunities({}, 100);
  const order = { STRONG: 0, POSSIBLE: 1, UNKNOWN: 2, WEAK: 3 } as const;
  rows.sort((a, b) => order[a.fit.tier] - order[b.fit.tier] || b.priority - a.priority);
  const ids = rows.map((r) => r.id);
  const [briefs, contactRows] = ids.length
    ? await Promise.all([
        db().select().from(salesBriefs).where(inArray(salesBriefs.dealershipId, ids)).orderBy(desc(salesBriefs.generatedAt)),
        db().select().from(contacts).where(inArray(contacts.dealershipId, ids)),
      ])
    : [[], []];
  const briefOf = new Map<string, (typeof briefs)[number]>();
  for (const b of briefs) if (!briefOf.has(b.dealershipId)) briefOf.set(b.dealershipId, b);
  void dealerships;

  return (
    <>
      <PageHeader title="Sales Intelligence" sub="Call briefs, best fit first. Every line traces to stored evidence; copy what you need.">
        <a className="btn" href="/api/export/daily-list">
          Export today&apos;s list (CSV)
        </a>
      </PageHeader>
      {rows.length === 0 ? (
        <Panel>
          <Empty>No dealerships on file yet.</Empty>
        </Panel>
      ) : (
        <div className="space-y-4">
          {rows.map((r) => {
            const b = briefOf.get(r.id);
            const own = contactRows.filter((c) => c.dealershipId === r.id);
            const all = [b?.salesAngle, b?.coldCallOpener ? `Opener: ${b.coldCallOpener}` : null, b?.discoveryQuestion ? `Discovery: ${b.discoveryQuestion}` : null].filter(Boolean).join("\n\n");
            return (
              <Panel
                key={r.id}
                id={r.id}
                title={
                  <span className="flex flex-wrap items-center gap-3 normal-case tracking-normal">
                    <A href={`/dealerships/${r.id}`} className="text-[15px]">
                      {r.name}
                    </A>
                    <span className="text-[12px] font-normal text-muted">{[r.city, r.state].filter(Boolean).join(", ")}</span>
                    <FitBadge fit={r.fit} withReasons={false} />
                  </span>
                }
                action={
                  <span className="flex items-center gap-2">
                    <span className="num text-[11px] uppercase tracking-[0.08em] text-muted">Priority</span>
                    <ScoreNumber score={r.priority} />
                    {all ? <CopyButton text={all} label="Copy brief" /> : null}
                  </span>
                }
              >
                <div className="grid gap-px bg-line-soft md:grid-cols-[1fr_1fr]">
                  <div className="space-y-3 bg-surface px-4 py-3 text-[13px]">
                    <div className="flex flex-wrap gap-x-5 gap-y-1">
                      <span>
                        <span className="text-muted">Recommended </span>
                        <ProductTag product={b?.recommendedProduct ?? r.recommendedProduct} />
                      </span>
                      {b?.recommendedRoles.length ? (
                        <span>
                          <span className="text-muted">Ask for </span>
                          {b.recommendedRoles[0]}
                        </span>
                      ) : null}
                      <span>
                        <span className="text-muted">Next </span>
                        {r.nextAction ?? b?.nextAction ?? "—"}
                      </span>
                    </div>
                    <CheckRow checks={r.checks} />
                    {b?.mainProblem ? <p className="text-[15px] font-medium leading-snug">{b.mainProblem}</p> : <p className="text-muted">No product opportunity found in the evidence yet.</p>}
                    {b?.salesAngle ? (
                      <div className="flex items-start gap-2">
                        <p className="flex-1 leading-relaxed">{b.salesAngle}</p>
                        <CopyButton text={b.salesAngle} />
                      </div>
                    ) : null}
                    {b?.coldCallOpener ? (
                      <div className="rounded-sm border border-line bg-paper p-3">
                        <div className="eyebrow mb-1">Cold-call opener</div>
                        <div className="flex items-start gap-2">
                          <p className="flex-1 leading-relaxed">&ldquo;{b.coldCallOpener}&rdquo;</p>
                          <CopyButton text={b.coldCallOpener} />
                        </div>
                        {b.discoveryQuestion ? (
                          <>
                            <div className="eyebrow mb-1 mt-3">Discovery question</div>
                            <div className="flex items-start gap-2">
                              <p className="flex-1 leading-relaxed">&ldquo;{b.discoveryQuestion}&rdquo;</p>
                              <CopyButton text={b.discoveryQuestion} />
                            </div>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="text-[12px] text-muted">
                      {own.length ? (
                        <>
                          Contacts: {own.map((c) => `${c.name}${c.title ? ` (${c.title})` : ""}`).join(", ")} — each with a source on file.
                        </>
                      ) : (
                        "No verified contact on file; the roles above are who to ask for."
                      )}
                      {b ? ` · Brief built ${fmtDate(b.generatedAt, true)} (${b.angleSource === "AI" ? "AI-written" : "template"} wording).` : ""}
                    </div>
                  </div>
                  <div className="bg-surface px-4 py-3 text-[13px]">
                    <div className="eyebrow mb-1.5">Evidence</div>
                    {b?.claims.length ? (
                      <ul className="space-y-1">
                        {b.claims.map((c, i) => (
                          <li key={i} className="grid grid-cols-[140px_1fr] items-baseline gap-2">
                            <Provenance kind={c.kind} confidence={c.confidence} />
                            <span>{c.text}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-muted">Nothing to cite yet.</p>
                    )}
                    <div className="mt-2 text-[12px]">
                      <A href={`/dealerships/${r.id}`}>Open the full research</A> · <A href={`/evidence?dealership=${r.id}`}>Screenshots</A>
                    </div>
                  </div>
                </div>
              </Panel>
            );
          })}
        </div>
      )}
    </>
  );
}
