import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { dealerships, suppressions, type Suppression } from "@/db/schema";
import { audit } from "@/lib/audit";
import { normalizeDomain, normalizePhone } from "@/lib/normalize";
import { emit } from "@/lib/agent-events";
import type { SuppressionReason, SuppressionScope } from "./constants";

export type SuppressionTarget = {
  dealershipId: string;
  groupId: string | null;
  normalizedDomain: string | null;
  normalizedPhone: string | null;
};

export type SuppressionRule = Pick<
  Suppression,
  "id" | "scope" | "dealershipId" | "groupId" | "domain" | "phone" | "reason" | "includeRooftops" | "active" | "expiresAt"
>;

export type SuppressionResult = { suppressed: boolean; matches: { id: string; scope: SuppressionScope; reason: SuppressionReason }[] };

/**
 * Pure suppression check. A rooftop is suppressed when any active, unexpired rule matches it:
 *  - DEALERSHIP: the rooftop itself
 *  - GROUP: its group, but only when the rule was created with includeRooftops
 *  - DOMAIN / PHONE: its normalised website domain or phone number
 */
export function evaluateSuppression(target: SuppressionTarget, rules: readonly SuppressionRule[], now: Date = new Date()): SuppressionResult {
  const matches: SuppressionResult["matches"] = [];
  for (const r of rules) {
    if (!r.active) continue;
    if (r.expiresAt && r.expiresAt.getTime() <= now.getTime()) continue;
    const hit =
      (r.scope === "DEALERSHIP" && r.dealershipId === target.dealershipId) ||
      (r.scope === "GROUP" && r.includeRooftops && target.groupId !== null && r.groupId === target.groupId) ||
      (r.scope === "DOMAIN" && target.normalizedDomain !== null && r.domain === target.normalizedDomain) ||
      (r.scope === "PHONE" && target.normalizedPhone !== null && r.phone === target.normalizedPhone);
    if (hit) matches.push({ id: r.id, scope: r.scope, reason: r.reason });
  }
  return { suppressed: matches.length > 0, matches };
}

async function activeRules(): Promise<Suppression[]> {
  return db().select().from(suppressions).where(eq(suppressions.active, true));
}

/** Authoritative check used right before any active interaction. Reads the rules table, not the cached flag. */
export async function checkSuppression(dealershipId: string): Promise<SuppressionResult> {
  const [d] = await db()
    .select({
      dealershipId: dealerships.id,
      groupId: dealerships.groupId,
      normalizedDomain: dealerships.normalizedDomain,
      normalizedPhone: dealerships.normalizedPhone,
    })
    .from(dealerships)
    .where(eq(dealerships.id, dealershipId))
    .limit(1);
  if (!d) return { suppressed: true, matches: [] }; // unknown rooftop: fail closed
  return evaluateSuppression(d, await activeRules());
}

/**
 * Recomputes the denormalised dealerships.suppressed flag for every rooftop.
 * Called after any rule change and after imports/edits that can change which rules match.
 */
export async function syncSuppressionFlags(): Promise<void> {
  const rules = await activeRules();
  const all = await db()
    .select({
      dealershipId: dealerships.id,
      groupId: dealerships.groupId,
      normalizedDomain: dealerships.normalizedDomain,
      normalizedPhone: dealerships.normalizedPhone,
      suppressed: dealerships.suppressed,
      suppressionReason: dealerships.suppressionReason,
    })
    .from(dealerships);
  const now = new Date();
  for (const d of all) {
    const res = evaluateSuppression(d, rules, now);
    const reason = res.matches[0]?.reason ?? null;
    if (res.suppressed !== d.suppressed || reason !== d.suppressionReason) {
      await db()
        .update(dealerships)
        .set({ suppressed: res.suppressed, suppressionReason: reason, updatedAt: now })
        .where(eq(dealerships.id, d.dealershipId));
    }
  }
}

export type NewSuppression = {
  scope: SuppressionScope;
  dealershipId?: string | null;
  groupId?: string | null;
  domain?: string | null;
  phone?: string | null;
  reason: SuppressionReason;
  note?: string | null;
  includeRooftops?: boolean;
  expiresAt?: Date | null;
};

export async function createSuppression(input: NewSuppression, actor: string): Promise<string> {
  const domain = input.scope === "DOMAIN" ? normalizeDomain(input.domain) : null;
  const phone = input.scope === "PHONE" ? normalizePhone(input.phone) : null;
  if (input.scope === "DEALERSHIP" && !input.dealershipId) throw new Error("A dealership is required for dealership-level suppression.");
  if (input.scope === "GROUP" && !input.groupId) throw new Error("A group is required for group-level suppression.");
  if (input.scope === "DOMAIN" && !domain) throw new Error("Enter a valid domain.");
  if (input.scope === "PHONE" && !phone) throw new Error("Enter a valid 10-digit phone number.");

  const [row] = await db()
    .insert(suppressions)
    .values({
      scope: input.scope,
      dealershipId: input.scope === "DEALERSHIP" ? input.dealershipId : null,
      groupId: input.scope === "GROUP" ? input.groupId : null,
      domain,
      phone,
      reason: input.reason,
      note: input.note?.trim() || null,
      includeRooftops: input.includeRooftops ?? true,
      expiresAt: input.expiresAt ?? null,
      createdBy: actor,
    })
    .returning({ id: suppressions.id });
  if (!row) throw new Error("Failed to create suppression");
  await syncSuppressionFlags();
  await audit(actor, "suppression.created", "suppression", row.id, { scope: input.scope, reason: input.reason, target: input.dealershipId ?? input.groupId ?? domain ?? phone });
  await emit(`Suppression added (${input.scope.toLowerCase()}, ${input.reason.toLowerCase().replace("_", " ")})`, { agent: "orion", dealershipId: input.scope === "DEALERSHIP" ? input.dealershipId : null, detail: `by ${actor}`, status: "BLOCKED", kind: "task.blocked" });
  return row.id;
}

export async function liftSuppression(id: string, actor: string): Promise<void> {
  await db()
    .update(suppressions)
    .set({ active: false, liftedBy: actor, liftedAt: new Date() })
    .where(and(eq(suppressions.id, id), eq(suppressions.active, true)));
  await syncSuppressionFlags();
  await audit(actor, "suppression.lifted", "suppression", id);
  await emit("Suppression lifted", { agent: "orion", detail: `by ${actor}`, status: "DONE" });
}

/** Deactivates rules whose expiry has passed so the cached flags stay truthful. */
export async function expireSuppressions(): Promise<number> {
  const expired = await db()
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(and(eq(suppressions.active, true), sql`${suppressions.expiresAt} is not null and ${suppressions.expiresAt} <= now()`));
  if (expired.length === 0) return 0;
  await db()
    .update(suppressions)
    .set({ active: false, liftedBy: "system:expired", liftedAt: new Date() })
    .where(inArray(suppressions.id, expired.map((e) => e.id)));
  await syncSuppressionFlags();
  return expired.length;
}
