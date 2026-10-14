/**
 * Ownership admin.
 *
 *   npm run ownership-admin -- status     the split: family-owned, privately owned, unverified, excluded
 *   npm run ownership-admin -- backfill   read the About page (and homepage) of every dealership not yet
 *                                         classified and store what it says; one or two pages each
 *
 * Nova does the same read inside every website scan from now on; this catches up the ones on file.
 * Needs the dev stack running (npm run fast / dev).
 */
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { dealerships } from "@/db/schema";
import { classifyOwnership, OWNERSHIP_LABEL } from "@/domain/ownership";
import { normalizeDomain } from "@/lib/normalize";
import { storeOwnership } from "@/lib/ownership-store";
import { getSettings } from "@/lib/settings";
import { Crawler } from "@/workers/website/crawler";
import { findLinks } from "@/workers/website/detect";

async function main() {
  const what = process.argv[2];
  if (what === "status") {
    const rows = await db().select({ ownership: dealerships.ownership, n: sql<number>`count(*)` }).from(dealerships).where(eq(dealerships.suppressed, false)).groupBy(dealerships.ownership);
    for (const r of rows) console.log(`${String(r.n).padStart(5)}  ${OWNERSHIP_LABEL[r.ownership]}`);
    return;
  }
  if (what === "backfill") {
    const rows = await db()
      .select({ id: dealerships.id, name: dealerships.name, website: dealerships.website, brands: dealerships.brands, domain: dealerships.normalizedDomain })
      .from(dealerships)
      .where(and(eq(dealerships.suppressed, false), or(isNull(dealerships.ownershipCheckedAt), eq(dealerships.ownership, "UNVERIFIED"))))
      .orderBy(dealerships.name);
    const settings = await getSettings();
    const tally: Record<string, number> = {};
    let n = 0;
    for (const d of rows) {
      n += 1;
      // Name, brand and domain alone can exclude a franchise or chain without a visit.
      const byName = classifyOwnership({ name: d.name, domain: d.domain, brands: d.brands, text: "" });
      if (byName.status === "EXCLUDED") {
        await storeOwnership(d.id, byName, { url: d.website, by: "system:ownership" });
        tally[byName.status] = (tally[byName.status] ?? 0) + 1;
        continue;
      }
      if (!d.website) continue;
      const crawler = await Crawler.open({ maxPages: 2, present: settings.researchPresentation });
      try {
        const home = await crawler.visit(d.website, "HOMEPAGE");
        let text = home.snapshot?.text ?? "";
        let sourceUrl: string | null = home.snapshot?.url ?? d.website;
        const about = home.snapshot ? findLinks(home.snapshot).ABOUT?.[0] : undefined;
        if (about) {
          const a = await crawler.visit(about, "ABOUT");
          if (a.snapshot) {
            text = `${a.snapshot.text}\n${text}`;
            sourceUrl = a.snapshot.url;
          }
        }
        const read = classifyOwnership({ name: d.name, domain: d.domain ?? normalizeDomain(d.website), brands: d.brands, text });
        await storeOwnership(d.id, read, { url: read.status === "UNVERIFIED" ? null : sourceUrl, by: "system:ownership" });
        tally[read.status] = (tally[read.status] ?? 0) + 1;
        console.log(`${String(n).padStart(4)}/${rows.length} ${d.name}: ${OWNERSHIP_LABEL[read.status]}${read.quote ? ` — "${read.quote.slice(0, 90)}"` : ""}`);
      } catch (err) {
        console.log(`${String(n).padStart(4)}/${rows.length} ${d.name}: could not read (${(err as Error).message.slice(0, 80)})`);
      } finally {
        await crawler.close();
      }
    }
    console.log("done:", Object.entries(tally).map(([k, v]) => `${OWNERSHIP_LABEL[k as keyof typeof OWNERSHIP_LABEL]} ${v}`).join(" · "));
    return;
  }
  console.error("usage: ownership-admin status | backfill");
  process.exit(2);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(), 200));
