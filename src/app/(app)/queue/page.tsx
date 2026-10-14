import { and, desc, eq, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { OWNERSHIP_LABEL } from "@/domain/ownership";
import { CopyButton } from "@/components/agent-ui";
import { SalesStatusBadge } from "@/components/checks";
import { A, Badge, Empty, PageHeader, Panel, fmtDate } from "@/components/ui";
import { db } from "@/db";
import { dealerGroups, dealerships, salesBriefs } from "@/db/schema";
import { INTENT_BAND_LABEL, READINESS_LABEL, bandFor, type BuyerReadiness } from "@/domain/intent";
import { formatPhone } from "@/lib/normalize";
import { getSettings } from "@/lib/settings";
import { describeWindow, isWithinWindow } from "@/domain/research-window";

const READINESS_RANK: Record<BuyerReadiness, number> = { CONFIRMED_INTEREST: 0, POSSIBLE_OPPORTUNITY: 1, NO_DEMONSTRATED_INTEREST: 2, NOT_INTERESTED: 3 };

/**
 * Today's call queue: who to call first, with the brief for each. Ranked by follow-ups that are
 * due, then confirmed interest, then the buying-intent score, then rooftops, then how recently a
 * buying signal was seen. Suppressed, not-interested, won and lost dealerships are left out, and so
 * is anyone touched in the last two days unless a follow-up is due.
 */
export default async function CallQueuePage({ searchParams }: { searchParams: Promise<{ limit?: string }> }) {
  const { limit: limitParam } = await searchParams;
  const limit = Math.min(200, Math.max(10, Number(limitParam) || 50));
  const settings = await getSettings();
  const now = new Date();
  const twoDaysAgo = new Date(now.getTime() - 2 * 86_400_000);
  const windowCfg = { enabled: settings.researchWindowEnabled, start: settings.researchWindowStart, end: settings.researchWindowEnd, timezone: settings.timezone };
  const rows = await db()
    .select({ d: dealerships, groupName: dealerGroups.name, storeCount: dealerGroups.storeCount })
    .from(dealerships)
    .leftJoin(dealerGroups, eq(dealerGroups.id, dealerships.groupId))
    .where(
      and(
        eq(dealerships.suppressed, false),
        eq(dealerships.paused, false),
        notInArray(dealerships.pipelineStage, ["WON", "LOST", "SUPPRESSED"]),
        eq(dealerships.ownership, "FAMILY_OWNED_INDEPENDENT"),
        or(isNull(dealerships.buyerReadiness), sql`${dealerships.buyerReadiness} <> 'NOT_INTERESTED'`),
        or(isNull(dealerships.lastTouchAt), lte(dealerships.lastTouchAt, twoDaysAgo), and(sql`${dealerships.nextActionDue} is not null`, lte(dealerships.nextActionDue, now))),
      ),
    )
    .orderBy(desc(dealerships.buyingIntent))
    .limit(600);
  const research = await db()
    .select({ id: dealerships.id, name: dealerships.name, city: dealerships.city, state: dealerships.state, ownership: dealerships.ownership, score: dealerships.buyingIntent, website: dealerships.website })
    .from(dealerships)
    .where(and(eq(dealerships.suppressed, false), inArray(dealerships.ownership, ["PRIVATELY_OWNED_INDEPENDENT", "UNVERIFIED"]), notInArray(dealerships.pipelineStage, ["WON", "LOST", "SUPPRESSED"])))
    .orderBy(desc(dealerships.buyingIntent))
    .limit(30);
  const ids = rows.map((r) => r.d.id);
  const briefs = ids.length ? await db().select().from(salesBriefs).where(inArray(salesBriefs.dealershipId, ids)).orderBy(desc(salesBriefs.generatedAt)) : [];
  const briefOf = new Map<string, (typeof briefs)[number]>();
  for (const b of briefs) if (!briefOf.has(b.dealershipId)) briefOf.set(b.dealershipId, b);

  const ranked = rows
    .map((r) => {
      const due = r.d.nextActionDue && r.d.nextActionDue.getTime() <= now.getTime();
      const readiness = (r.d.buyerReadiness ?? "NO_DEMONSTRATED_INTEREST") as BuyerReadiness;
      return { ...r, due: Boolean(due), readiness, score: r.d.buyingIntent ?? 0, rooftops: Math.max(r.storeCount ?? 0, 1) };
    })
    .sort((a, b) => Number(b.due) - Number(a.due) || READINESS_RANK[a.readiness] - READINESS_RANK[b.readiness] || b.score - a.score || b.rooftops - a.rooftops || (b.d.intentAt?.getTime() ?? 0) - (a.d.intentAt?.getTime() ?? 0))
    .slice(0, limit);

  return (
    <>
      <PageHeader title="Call queue" sub={`${ranked.length} verified family-owned independent dealership(s) in order · ${isWithinWindow(now, windowCfg) ? "inside" : "outside"} approved outreach hours (${describeWindow(windowCfg)}) · follow-ups that are due come first, then confirmed interest, then buying intent`}>
        <A href="/opportunities">All scores</A>
        <A href="/results">Results by band</A>
      </PageHeader>
      {ranked.length === 0 ? (
        <Panel>
          <Empty>Nothing to call right now. Everyone eligible was touched in the last two days, or has no score yet.</Empty>
        </Panel>
      ) : (
        <div className="space-y-3">
          {ranked.map((r, n) => {
            const b = briefOf.get(r.d.id);
            const band = bandFor(r.score);
            const phone = formatPhone(r.d.normalizedPhone) ?? r.d.phone;
            const copy = [b?.coldCallOpener ? `Opener: ${b.coldCallOpener}` : null, b?.discoveryQuestion ? `Discovery: ${b.discoveryQuestion}` : null, b?.salesAngle ?? null].filter(Boolean).join("\n\n");
            return (
              <Panel
                key={r.d.id}
                title={
                  <span className="flex flex-wrap items-center gap-3 normal-case tracking-normal">
                    <span className="num text-[12px] text-muted">#{n + 1}</span>
                    <A href={`/dealerships/${r.d.id}`} className="text-[15px]">
                      {r.d.name}
                    </A>
                    <span className="text-[12px] font-normal text-muted">
                      {[r.d.city, r.d.state].filter(Boolean).join(", ")}
                      {r.groupName ? ` · ${r.groupName} (${r.rooftops} rooftops)` : ""}
                    </span>
                    {r.due ? <Badge tone="warn">Follow-up due</Badge> : null}
                  </span>
                }
                action={
                  <span className="flex items-center gap-3">
                    {phone ? (
                      <a href={`tel:${r.d.normalizedPhone ? `+1${r.d.normalizedPhone}` : r.d.phone}`} className="num text-[14px] font-medium text-blue-light hover:underline">
                        {phone}
                      </a>
                    ) : (
                      <span className="text-[12px] text-faint">no phone</span>
                    )}
                    {copy ? <CopyButton text={copy} label="Copy script" /> : null}
                  </span>
                }
              >
                <div className="grid gap-4 p-4 md:grid-cols-[200px_1fr]">
                  <div className="space-y-1.5 text-[13px]">
                    <div>
                      <span className="num text-[26px] font-medium leading-none" style={{ color: band === "HIGH" ? "var(--color-good)" : band === "MEDIUM" ? "var(--color-warn)" : "var(--color-muted)" }}>
                        {r.score}
                      </span>
                      <span className="text-muted"> / 100 · {INTENT_BAND_LABEL[band]}</span>
                    </div>
                    <div className="text-muted">
                      Readiness: <span className="text-text">{READINESS_LABEL[r.readiness]}</span>
                    </div>
                    <div className="text-muted">
                      Confidence: <span className="text-text">{(r.d.intentConfidence ?? "LOW").toLowerCase()}</span>
                    </div>
                    <div>
                      <SalesStatusBadge status={r.d.salesStatus} at={r.d.lastTouchAt} />
                    </div>
                    {r.d.nextAction ? (
                      <div className="text-muted">
                        Next: <span className="text-text">{r.d.nextAction}</span>
                        {r.d.nextActionDue ? ` · ${fmtDate(r.d.nextActionDue)}` : ""}
                      </div>
                    ) : null}
                  </div>
                  <div className="space-y-2 text-[13.5px]">
                    {b?.mainProblem ? <p className="font-medium">{b.mainProblem}</p> : <p className="text-muted">No brief yet; Blaze writes one after the research finishes.</p>}
                    {b?.coldCallOpener ? <p className="rounded-md border border-line bg-charcoal px-3 py-2 italic text-muted">&ldquo;{b.coldCallOpener}&rdquo;</p> : null}
                    {b?.discoveryQuestion ? (
                      <p className="text-muted">
                        <span className="eyebrow mr-1">Discovery</span>
                        {b.discoveryQuestion}
                      </p>
                    ) : null}
                    {b?.recommendedProduct ? (
                      <p className="text-[12.5px] text-faint">
                        Recommended: {b.recommendedProduct.replace(/_/g, " ").toLowerCase()} · log the outcome on the dealership page under <A href={`/dealerships/${r.d.id}#sales`}>Sales log</A>
                      </p>
                    ) : null}
                  </div>
                </div>
              </Panel>
            );
          })}
        </div>
      )}
      <Panel title="Research queue · not yet eligible" className="mt-6">
        <p className="px-4 py-2 text-[12.5px] text-muted">Privately owned or unverified dealerships are never assigned to the outbound queue. Verify ownership on the dealership page (About page, state dealer licence, business registry) and they move up; franchise and corporate stores are excluded for good.</p>
        {research.length === 0 ? (
          <Empty>Nothing waiting for verification.</Empty>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Dealership</th>
                <th>Ownership</th>
                <th className="text-right">Buying intent</th>
                <th>Verify</th>
              </tr>
            </thead>
            <tbody>
              {research.map((r) => (
                <tr key={r.id}>
                  <td>
                    <A href={`/dealerships/${r.id}#ownership`}>{r.name}</A>
                    <span className="ml-2 text-[12px] text-muted">{[r.city, r.state].filter(Boolean).join(", ")}</span>
                  </td>
                  <td>{OWNERSHIP_LABEL[r.ownership]}</td>
                  <td className="num text-right">{r.score ?? "—"}</td>
                  <td className="text-[12.5px]">{r.website ? <a href={r.website} target="_blank" rel="noreferrer" className="text-blue-light hover:underline">Open site</a> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
