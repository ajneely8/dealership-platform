import { eq } from "drizzle-orm";
import { db } from "@/db";
import { dealerships } from "@/db/schema";
import { OWNERSHIP_LABEL, type OwnershipRead } from "@/domain/ownership";
import { emit } from "./agent-events";

/**
 * Writes an ownership read onto the dealership with its evidence (the quote, the page it came
 * from, when). An automatic read never overwrites a classification a person verified by hand.
 */
export async function storeOwnership(dealershipId: string, read: OwnershipRead, source: { url: string | null; by: string }): Promise<boolean> {
  const [d] = await db().select({ ownership: dealerships.ownership, method: dealerships.ownershipMethod }).from(dealerships).where(eq(dealerships.id, dealershipId)).limit(1);
  if (!d) return false;
  if (d.method === "manual" && !source.by.startsWith("manual:")) return false;
  const now = new Date();
  await db()
    .update(dealerships)
    .set({ ownership: read.status, ownershipQuote: read.quote, ownershipReason: read.reason, ownershipSourceUrl: source.url, ownershipMethod: source.by.startsWith("manual:") ? "manual" : "website", ownershipVerifiedAt: read.status === "UNVERIFIED" ? null : now, ownershipVerifiedBy: source.by, ownershipCheckedAt: now, updatedAt: now })
    .where(eq(dealerships.id, dealershipId));
  if (d.ownership !== read.status) {
    await emit(`Ownership: ${OWNERSHIP_LABEL[read.status]}`, { agent: "nova", dealershipId, detail: `${read.reason}${read.quote ? ` · "${read.quote}"` : ""}${source.url ? ` · ${source.url}` : ""}`, status: read.status === "EXCLUDED" ? "BLOCKED" : "DONE", kind: read.status === "EXCLUDED" ? "task.blocked" : "finding.created" });
  }
  return true;
}
