import { and, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { dealerships, prospects } from "@/db/schema";

/**
 * Read-only views of prospecting for the pages. Kept apart from the prospecting worker so the
 * web app (and the hosted viewer on Vercel) never loads the browser automation it depends on.
 */

/** Figures for the Prospecting page and the command strip. */
export async function prospectStats(now = new Date()) {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const rows = await db().select({ status: prospects.status, n: count() }).from(prospects).where(or(isNull(prospects.screenedAt), sql`${prospects.screenedAt} >= ${startOfDay}`)).groupBy(prospects.status);
  const get = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
  return { pool: get("NEW"), screening: get("SCREENING"), admittedToday: get("ADMITTED"), rejectedToday: get("REJECTED") };
}

export async function recentProspects(limit = 60) {
  return db()
    .select({ p: prospects, dealershipName: dealerships.name })
    .from(prospects)
    .leftJoin(dealerships, eq(dealerships.id, prospects.dealershipId))
    .where(inArray(prospects.status, ["SCREENING", "ADMITTED", "REJECTED"]))
    .orderBy(desc(prospects.screenedAt), desc(prospects.createdAt))
    .limit(limit);
}

export async function candidatePool(limit = 30) {
  return db().select().from(prospects).where(and(eq(prospects.status, "NEW"))).orderBy(sql`${prospects.distanceKm} asc nulls last`).limit(limit);
}
