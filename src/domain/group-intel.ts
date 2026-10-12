import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db";
import { dealerGroups, dealerships, scores, signals, websiteObservations, type GroupIntel, type ScoreReason } from "@/db/schema";
import { PRODUCTS, type Product } from "./constants";
import { RULES } from "./scoring/config";

export type RooftopSummary = {
  id: string;
  priorityScore: number;
  scanned: boolean;
  technology: { name: string; category: string }[];
  scores: { product: Product; score: number; reasons: Pick<ScoreReason, "ruleId" | "label">[] }[];
  hiringSignals: number;
};

/**
 * Rolls rooftops up to the group. A problem is "systemic" when the same scoring rule fired at
 * two or more rooftops and at least 40% of the rooftops we have scanned — one sale may fix it everywhere.
 */
export function aggregateGroup(rooftops: readonly RooftopSummary[], storeCount: number | null): { intel: GroupIntel; groupScore: number } {
  const scanned = rooftops.filter((r) => r.scanned);
  const tech = new Map<string, { name: string; category: string; count: number }>();
  for (const r of scanned) {
    for (const t of new Map(r.technology.map((x) => [x.name, x])).values()) {
      const cur = tech.get(t.name) ?? { name: t.name, category: t.category, count: 0 };
      cur.count += 1;
      tech.set(t.name, cur);
    }
  }
  const sharedTechnology = [...tech.values()].filter((t) => t.count >= 2 && t.category !== "Analytics").sort((a, b) => b.count - a.count);

  const ruleHits = new Map<string, number>();
  for (const r of rooftops) {
    const fired = new Set(r.scores.flatMap((s) => s.reasons.map((x) => x.ruleId)));
    for (const id of fired) ruleHits.set(id, (ruleHits.get(id) ?? 0) + 1);
  }
  const base = Math.max(scanned.length, 1);
  const systemicProblems = [...ruleHits.entries()]
    .filter(([, n]) => n >= 2 && n / base >= 0.4)
    .map(([ruleId, count]) => {
      const meta = RULES.find((x) => x.id === ruleId);
      return meta ? { ruleId, label: meta.label, product: meta.product, count, share: Math.round((count / base) * 100) / 100 } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.count - a.count);

  const productAverages = Object.fromEntries(
    PRODUCTS.map((p) => {
      const vals = rooftops.map((r) => r.scores.find((s) => s.product === p)?.score ?? 0);
      return [p, vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0];
    }),
  ) as Record<Product, number>;

  const priorities = rooftops.map((r) => r.priorityScore);
  const avg = priorities.length ? priorities.reduce((a, b) => a + b, 0) / priorities.length : 0;
  const max = priorities.length ? Math.max(...priorities) : 0;
  const size = Math.max(storeCount ?? 0, rooftops.length);
  const sizeBonus = size >= 10 ? 10 : size >= 5 ? 6 : size >= 2 ? 3 : 0;
  // Group score: mostly the rooftops' own priorities, lifted when problems repeat and when the group is large.
  const groupScore = max === 0 ? 0 : Math.min(100, Math.round(avg * 0.5 + max * 0.3 + Math.min(15, systemicProblems.length * 5) + sizeBonus));

  return {
    intel: {
      rooftops: rooftops.length,
      scanned: scanned.length,
      sharedTechnology,
      systemicProblems,
      productAverages,
      hiringSignalCount: rooftops.reduce((a, r) => a + r.hiringSignals, 0),
    },
    groupScore,
  };
}

export async function refreshGroupIntel(groupId: string): Promise<void> {
  const [group] = await db().select().from(dealerGroups).where(eq(dealerGroups.id, groupId)).limit(1);
  if (!group) return;
  const rooftops = await db().select({ id: dealerships.id, priorityScore: dealerships.priorityScore, brands: dealerships.brands }).from(dealerships).where(eq(dealerships.groupId, groupId));
  const ids = rooftops.map((r) => r.id);
  if (ids.length === 0) {
    await db().update(dealerGroups).set({ intel: null, priorityScore: 0, updatedAt: new Date() }).where(eq(dealerGroups.id, groupId));
    return;
  }
  const observations = await db()
    .select({ dealershipId: websiteObservations.dealershipId, tech: websiteObservations.detectedTechnology, timestamp: websiteObservations.timestamp })
    .from(websiteObservations)
    .where(and(inArray(websiteObservations.dealershipId, ids), eq(websiteObservations.websiteStatus, "OK")))
    .orderBy(desc(websiteObservations.timestamp));
  const latest = new Map<string, (typeof observations)[number]>();
  for (const o of observations) if (!latest.has(o.dealershipId)) latest.set(o.dealershipId, o);

  const scoreRows = await db().select().from(scores).where(inArray(scores.dealershipId, ids));
  const hiring = await db()
    .select({ dealershipId: signals.dealershipId, type: signals.type })
    .from(signals)
    .where(and(inArray(signals.dealershipId, ids), gte(signals.detectedAt, new Date(Date.now() - 60 * 86_400_000))));

  const { intel, groupScore } = aggregateGroup(
    rooftops.map((r) => ({
      id: r.id,
      priorityScore: r.priorityScore,
      scanned: latest.has(r.id),
      technology: latest.get(r.id)?.tech ?? [],
      scores: scoreRows.filter((s) => s.dealershipId === r.id).map((s) => ({ product: s.product, score: s.score, reasons: s.reasons })),
      hiringSignals: hiring.filter((h) => h.dealershipId === r.id && h.type.endsWith("_HIRING")).length,
    })),
    group.storeCount,
  );
  const brands = [...new Set([...group.brands, ...rooftops.flatMap((r) => r.brands)])].sort();
  await db().update(dealerGroups).set({ intel, priorityScore: groupScore, brands, lastChecked: new Date(), updatedAt: new Date() }).where(eq(dealerGroups.id, groupId));
}
