/**
 * Who owns the dealership, and whether it is a target at all. SarvX sells to family-owned and
 * privately owned independent dealerships; manufacturer franchise stores, national chains and
 * corporate or publicly traded groups are excluded no matter how well they score.
 *
 *   FAMILY_OWNED_INDEPENDENT   verified: the dealership says so on its own site (About page or
 *                              homepage), or a person verified it from a credible public source
 *   PRIVATELY_OWNED_INDEPENDENT verified privately/locally/independently owned, family not stated
 *   UNVERIFIED                  nothing credible found yet; stays in the research queue
 *   EXCLUDED                    franchise, chain, corporate or publicly traded
 *
 * Being small is never taken as proof of family ownership; only a statement or a record is.
 */
export const OWNERSHIP_STATUSES = ["FAMILY_OWNED_INDEPENDENT", "PRIVATELY_OWNED_INDEPENDENT", "UNVERIFIED", "EXCLUDED"] as const;
export type OwnershipStatus = (typeof OWNERSHIP_STATUSES)[number];
export const OWNERSHIP_LABEL: Record<OwnershipStatus, string> = {
  FAMILY_OWNED_INDEPENDENT: "Verified family-owned independent",
  PRIVATELY_OWNED_INDEPENDENT: "Verified privately owned independent",
  UNVERIFIED: "Ownership unverified",
  EXCLUDED: "Franchise / corporate — excluded",
};

/** Manufacturer names, matched against the dealership name and the OSM brand tag. */
export const FRANCHISE = /\b(ford|lincoln|chevrolet|chevy|gmc|buick|cadillac|chrysler|jeep|dodge|ram|cdjr|fiat|alfa romeo|maserati|toyota|lexus|honda|acura|nissan|infiniti|hyundai|genesis|kia|mazda|subaru|mitsubishi|volkswagen|vw|audi|bmw|mini|mercedes|benz|porsche|volvo|jaguar|land rover|range rover|tesla|rivian|lucid|polestar|scion|saturn|pontiac|oldsmobile|isuzu|suzuki)\b/i;
export const FRANCHISE_DOMAIN = /ford|lincoln|chevrolet|chevy|gmc|buick|cadillac|chrysler|jeep|dodge|cdjr|toyota|lexus|honda|acura|nissan|infiniti|hyundai|genesis|kia(?![a-z])|mazda|subaru|mitsubishi|volkswagen|audi|bmw|mercedes|porsche|volvo|jaguar|landrover/i;
/** National chains and corporate groups that are never prospects. */
export const NATIONAL_CHAINS = /carmax|carvana|autonation|drivetime|vroom|shift\.com|enterprise|hertz|avis|budget|copart|iaa[i.]|tesla|rivian|lucid|echopark|byrider|lithia|sonic automotive|group ?1 automotive|penske|asbury|hendrick|larry h\.? miller|ken garff|morgan auto|autobell/i;

/** Is this a manufacturer franchise store? */
export function isFranchise(c: { name: string; domain?: string | null; brand?: string | null; brands?: readonly string[] }): boolean {
  if (c.brand && c.brand.trim()) return true;
  if (c.brands?.some((b) => FRANCHISE.test(b))) return true;
  if (FRANCHISE.test(c.name)) return true;
  if (c.domain && FRANCHISE_DOMAIN.test(c.domain)) return true;
  return false;
}

const FAMILY = /\b(family[- ](owned|run|operated)|owned (and|&) operated by the [A-Z][a-z]+ family|(second|third|fourth|2nd|3rd|4th|three|two)[- ]generation|father[- ]and[- ]son|husband[- ]and[- ]wife|our family (has|have|is|business)|a family business|family dealership)\b/i;
const PRIVATE = /\b((locally|independently|privately|veteran|woman|minority)[- ]owned|owner[- ]operated|independent (used[- ]car )?dealer(ship)?|owned (and|&) operated)\b/i;
const CORPORATE = /\b(publicly[- ]traded|nyse|nasdaq|a subsidiary of|part of the [A-Z][A-Za-z]+ (automotive|auto) group|fortune 500)\b/i;
const CLAIMED_FRANCHISE = /\b(authorized|franchised?|official) (dealer|dealership) (for|of)\b|\bnew (ford|chevrolet|toyota|honda|nissan|hyundai|kia|subaru|mazda|bmw|mercedes)\b/i;

export type OwnershipRead = { status: OwnershipStatus; quote: string | null; reason: string; confidence: "HIGH" | "MEDIUM" | "LOW" };

/** Classifies ownership from what the site says. `text` is the About page (and homepage) text. */
export function classifyOwnership(input: { name: string; domain: string | null; brands: readonly string[]; text: string }): OwnershipRead {
  const { text } = input;
  if (isFranchise({ name: input.name, domain: input.domain, brands: input.brands })) return { status: "EXCLUDED", quote: null, reason: "manufacturer franchise store (name, brand or domain)", confidence: "HIGH" };
  if (NATIONAL_CHAINS.test(input.name) || (input.domain && NATIONAL_CHAINS.test(input.domain))) return { status: "EXCLUDED", quote: null, reason: "national chain or corporate group", confidence: "HIGH" };
  const sentence = (re: RegExp): string | null => {
    const m = re.exec(text);
    if (!m) return null;
    const start = Math.max(0, text.lastIndexOf(".", m.index) + 1);
    const end = text.indexOf(".", m.index + m[0].length);
    return text.slice(start, end > 0 ? end + 1 : Math.min(text.length, m.index + 160)).replace(/\s+/g, " ").trim().slice(0, 240);
  };
  const corp = sentence(CORPORATE);
  if (corp) return { status: "EXCLUDED", quote: corp, reason: "the site describes corporate or publicly traded ownership", confidence: "MEDIUM" };
  const fr = sentence(CLAIMED_FRANCHISE);
  if (fr) return { status: "EXCLUDED", quote: fr, reason: "the site describes itself as a manufacturer-franchised dealer", confidence: "MEDIUM" };
  const fam = sentence(FAMILY);
  if (fam) return { status: "FAMILY_OWNED_INDEPENDENT", quote: fam, reason: "the dealership states it is family-owned on its own site", confidence: "HIGH" };
  const priv = sentence(PRIVATE);
  if (priv) return { status: "PRIVATELY_OWNED_INDEPENDENT", quote: priv, reason: "the dealership states it is privately or independently owned", confidence: "MEDIUM" };
  return { status: "UNVERIFIED", quote: null, reason: "no ownership statement found on the pages read", confidence: "LOW" };
}

/** Only verified family-owned independents go to the active outbound queue. */
export const queueEligible = (ownership: OwnershipStatus | null | undefined): boolean => ownership === "FAMILY_OWNED_INDEPENDENT";
/** Privately owned and unverified dealerships wait in the research queue; excluded ones go nowhere. */
export const researchQueueEligible = (ownership: OwnershipStatus | null | undefined): boolean => ownership === "PRIVATELY_OWNED_INDEPENDENT" || ownership === "UNVERIFIED" || !ownership;
