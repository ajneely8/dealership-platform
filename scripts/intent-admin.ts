/**
 * Buying-intent admin.
 *
 *   npm run intent-admin -- backfill   score every dealership on file now (Atlas does it after each research pass)
 *   npm run intent-admin -- status     how many are scored, and the band split
 *
 * Needs the dev stack running (npm run fast / dev).
 */
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { dealerships } from "@/db/schema";
import { runBuyingIntent } from "@/domain/intent-run";

async function main() {
  const what = process.argv[2];
  if (what === "status") {
    const [r] = await db()
      .select({ total: sql<number>`count(*)`, scored: sql<number>`count(*) filter (where ${dealerships.buyingIntent} is not null)`, high: sql<number>`count(*) filter (where ${dealerships.buyingIntent} >= 75)`, medium: sql<number>`count(*) filter (where ${dealerships.buyingIntent} between 45 and 74)`, low: sql<number>`count(*) filter (where ${dealerships.buyingIntent} < 45)` })
      .from(dealerships)
      .where(eq(dealerships.suppressed, false));
    console.log(`dealerships ${r?.total} · scored ${r?.scored} · high ${r?.high} · medium ${r?.medium} · low ${r?.low}`);
    return;
  }
  if (what === "backfill") {
    const rows = await db().select({ id: dealerships.id, name: dealerships.name }).from(dealerships).where(eq(dealerships.suppressed, false)).orderBy(dealerships.name);
    let done = 0;
    const bands = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const d of rows) {
      const r = await runBuyingIntent(d.id);
      if (r) {
        done += 1;
        bands[r.band] += 1;
      }
    }
    console.log(`${done} of ${rows.length} dealership(s) scored · high ${bands.HIGH} · medium ${bands.MEDIUM} · low ${bands.LOW}`);
    return;
  }
  console.error("usage: intent-admin backfill | status");
  process.exit(2);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(), 200));
