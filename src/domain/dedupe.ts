import { or, eq, and, ne, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { dealerships } from "@/db/schema";
import { normalizeAddress, normalizeDomain, normalizeName, normalizePhone, normalizeState } from "@/lib/normalize";

export type DedupeCandidate = {
  name: string;
  website?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  groupId?: string | null;
};

export type DedupeKeys = {
  normalizedName: string;
  normalizedDomain: string | null;
  normalizedPhone: string | null;
  normalizedAddress: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  groupId: string | null;
};

export type DedupeExisting = DedupeKeys & { id: string; name: string };

export type DuplicateMatch = { id: string; name: string; reason: "DOMAIN" | "PHONE" | "ADDRESS" | "NAME_LOCATION" | "NAME_GROUP" };

export function dedupeKeys(c: DedupeCandidate): DedupeKeys {
  return {
    normalizedName: normalizeName(c.name),
    normalizedDomain: normalizeDomain(c.website),
    normalizedPhone: normalizePhone(c.phone),
    normalizedAddress: normalizeAddress(c.address),
    city: c.city?.trim().toLowerCase() || null,
    state: normalizeState(c.state),
    zip: c.zip?.trim().slice(0, 5) || null,
    groupId: c.groupId ?? null,
  };
}

/**
 * Decides whether a candidate rooftop already exists.
 * Checked in order of reliability: domain, phone, street address, then name within the
 * same city/state or the same group. A shared name alone is never enough — "Toyota of X"
 * style names repeat across the country.
 */
export function findDuplicate(candidate: DedupeKeys, existing: readonly DedupeExisting[]): DuplicateMatch | null {
  for (const e of existing) {
    if (candidate.normalizedDomain && candidate.normalizedDomain === e.normalizedDomain) return { id: e.id, name: e.name, reason: "DOMAIN" };
  }
  for (const e of existing) {
    if (candidate.normalizedPhone && candidate.normalizedPhone === e.normalizedPhone) return { id: e.id, name: e.name, reason: "PHONE" };
  }
  for (const e of existing) {
    if (!candidate.normalizedAddress || candidate.normalizedAddress !== e.normalizedAddress) continue;
    const sameZip = candidate.zip && candidate.zip === e.zip;
    const sameCity = candidate.city && candidate.state && candidate.city === e.city && candidate.state === e.state;
    // An address with no locality on either side still matches: street + number is specific enough.
    const noLocality = !candidate.zip && !candidate.city && !e.zip && !e.city;
    if (sameZip || sameCity || noLocality) return { id: e.id, name: e.name, reason: "ADDRESS" };
  }
  for (const e of existing) {
    if (!candidate.normalizedName || candidate.normalizedName !== e.normalizedName) continue;
    if (candidate.city && candidate.state && candidate.city === e.city && candidate.state === e.state) {
      return { id: e.id, name: e.name, reason: "NAME_LOCATION" };
    }
    if (candidate.groupId && candidate.groupId === e.groupId) return { id: e.id, name: e.name, reason: "NAME_GROUP" };
  }
  return null;
}

/** Loads only rows that could possibly match, then applies the pure rules above. */
export async function findDuplicateInDb(candidate: DedupeCandidate, excludeId?: string): Promise<DuplicateMatch | null> {
  const keys = dedupeKeys(candidate);
  const conditions: SQL[] = [eq(dealerships.normalizedName, keys.normalizedName)];
  if (keys.normalizedDomain) conditions.push(eq(dealerships.normalizedDomain, keys.normalizedDomain));
  if (keys.normalizedPhone) conditions.push(eq(dealerships.normalizedPhone, keys.normalizedPhone));
  if (keys.normalizedAddress) conditions.push(eq(dealerships.normalizedAddress, keys.normalizedAddress));
  const where = excludeId ? and(or(...conditions), ne(dealerships.id, excludeId)) : or(...conditions);
  const rows = await db()
    .select({
      id: dealerships.id,
      name: dealerships.name,
      normalizedName: dealerships.normalizedName,
      normalizedDomain: dealerships.normalizedDomain,
      normalizedPhone: dealerships.normalizedPhone,
      normalizedAddress: dealerships.normalizedAddress,
      city: dealerships.city,
      state: dealerships.state,
      zip: dealerships.zip,
      groupId: dealerships.groupId,
    })
    .from(dealerships)
    .where(where);
  return findDuplicate(
    keys,
    rows.map((r) => ({ ...r, city: r.city?.toLowerCase() ?? null, zip: r.zip?.slice(0, 5) ?? null })),
  );
}
