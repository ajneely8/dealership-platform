import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { dealerships, inventorySnapshots } from "@/db/schema";
import type { AgentKey } from "@/domain/agents";
import { describeVolume, estimateVolume, fmtUsd } from "@/domain/volume";
import { emit } from "@/lib/agent-events";

/**
 * Sentinel's job: from the inventory snapshots on file, estimate how many vehicles the dealership
 * sells a month and what that is worth, and write it on the dealership so every list and card
 * can show it. Reading the inventory pages is the `inventory` job (also Sentinel's); this one is
 * arithmetic over what was read, so it is quick and runs after every website scan.
 */
export async function storeEstimate(dealershipId: string, opts: { agent?: AgentKey } = {}): Promise<string> {
  const [d] = await db().select({ name: dealerships.name }).from(dealerships).where(eq(dealerships.id, dealershipId)).limit(1);
  if (!d) return "SKIPPED: dealership not found";
  const history = await db()
    .select({ capturedAt: inventorySnapshots.capturedAt, total: inventorySnapshots.total, vdpUrls: inventorySnapshots.vdpUrls, medianPrice: inventorySnapshots.medianPrice, prices: inventorySnapshots.prices, newCount: inventorySnapshots.newCount, usedCount: inventorySnapshots.usedCount, pricesHidden: inventorySnapshots.pricesHidden })
    .from(inventorySnapshots)
    .where(eq(inventorySnapshots.dealershipId, dealershipId))
    .orderBy(desc(inventorySnapshots.capturedAt))
    .limit(12);
  const v = estimateVolume(history);
  const now = new Date();
  const base = { agent: opts.agent, dealershipId };

  if (!v) {
    await db()
      .update(dealerships)
      .set({ estUnitsLow: null, estUnitsHigh: null, estGrossLow: null, estGrossHigh: null, estMedianPrice: null, estMethod: null, estConfidence: null, estAt: now, estProfitLow: null, estProfitHigh: null, estProfitPerUnit: null, estCommissionPerUnit: null, estSegment: null, estPricesHidden: false })
      .where(eq(dealerships.id, dealershipId));
    await emit(`No estimate yet for ${d.name}: the lot could not be counted`, { ...base, detail: history.length ? "the inventory pages did not state a total and too few listings were seen; the next inventory read tries again" : "no inventory snapshot on file yet; an inventory read is needed first", status: "BLOCKED", kind: "task.blocked" });
    return "OK: no estimate (lot not countable yet)";
  }

  await db()
    .update(dealerships)
    .set({ estUnitsLow: v.unitsLow, estUnitsHigh: v.unitsHigh, estGrossLow: v.grossLow, estGrossHigh: v.grossHigh, estMedianPrice: v.medianPrice, estMethod: v.method, estConfidence: v.confidence, estAt: now, estProfitLow: v.profitLow, estProfitHigh: v.profitHigh, estProfitPerUnit: v.profitPerUnit, estCommissionPerUnit: v.commissionPerUnit, estSegment: v.segment, estPricesHidden: v.pricesHidden })
    .where(eq(dealerships.id, dealershipId));
  await emit(`${d.name}: estimated ${describeVolume(v)}`, { ...base, detail: `${v.basis}. Assumptions: ${v.assumptions.join("; ")}`, status: "DONE", kind: "finding.created" });
  const profit = v.profitLow !== null && v.profitHigh !== null ? ` · ${fmtUsd(v.profitLow)}-${fmtUsd(v.profitHigh)} gross profit` : "";
  return `OK: about ${v.unitsLow}-${v.unitsHigh} vehicles a month${profit} (${v.method === "TURNOVER" ? "measured turnover" : "lot size"}, ${v.confidence.toLowerCase()} confidence)`;
}
