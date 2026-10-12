/**
 * Sentinel admin: estimates for every dealership on file.
 *
 *   npm run estimate-admin -- status     how many dealerships carry an estimate, and by which method
 *   npm run estimate-admin -- backfill   write an estimate for every dealership from the snapshots on
 *                                        file right now, and queue an inventory read (Sentinel) for
 *                                        every one whose lot has not been counted or priced yet
 *
 * Needs the dev stack running (npm run fast / dev).
 */
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { dealerships, inventorySnapshots } from "@/db/schema";
import { closeQueues, enqueue } from "@/queue";
import { storeEstimate } from "@/workers/estimate";

async function main() {
  const what = process.argv[2];
  if (what === "status") {
    const [row] = await db()
      .select({
        total: sql<number>`count(*)`,
        estimated: sql<number>`count(*) filter (where ${dealerships.estUnitsLow} is not null)`,
        withGross: sql<number>`count(*) filter (where ${dealerships.estGrossLow} is not null)`,
        turnover: sql<number>`count(*) filter (where ${dealerships.estMethod} = 'TURNOVER')`,
        notCountable: sql<number>`count(*) filter (where ${dealerships.estAt} is not null and ${dealerships.estUnitsLow} is null)`,
      })
      .from(dealerships)
      .where(eq(dealerships.suppressed, false));
    console.log(`dealerships ${row?.total} · estimated ${row?.estimated} (with a revenue figure ${row?.withGross}; measured from turnover ${row?.turnover}) · lot not countable ${row?.notCountable}`);
    return;
  }
  if (what === "backfill") {
    const rows = await db().select({ id: dealerships.id, name: dealerships.name }).from(dealerships).where(and(eq(dealerships.suppressed, false), eq(dealerships.paused, false))).orderBy(dealerships.name);
    let estimated = 0;
    let queued = 0;
    for (const d of rows) {
      const r = await storeEstimate(d.id, { agent: "sentinel" });
      if (r.startsWith("OK: about")) estimated += 1;
      // A read is queued when the lot was never counted, or was counted without any prices (older scans).
      const [latest] = await db().select({ total: inventorySnapshots.total, medianPrice: inventorySnapshots.medianPrice }).from(inventorySnapshots).where(eq(inventorySnapshots.dealershipId, d.id)).orderBy(desc(inventorySnapshots.capturedAt)).limit(1);
      if (!latest || latest.total === null || latest.medianPrice === null) {
        if ((await enqueue("inventory", { dealershipId: d.id, manual: true })).queued) queued += 1;
      }
    }
    console.log(`${rows.length} dealership(s): ${estimated} estimated from snapshots on file; ${queued} inventory read(s) queued for Sentinel (lots not yet counted or priced)`);
    await closeQueues().catch(() => undefined);
    return;
  }
  void isNull;
  void or;
  console.error("usage: estimate-admin status | backfill");
  process.exit(2);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(), 200));
