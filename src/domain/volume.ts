/**
 * Sentinel's model: what a dealership sells a month and what it makes, from its own inventory.
 * Inferences, never reported figures; every number carries its method, its confidence and the
 * assumptions it rests on, and the assumptions are industry norms for US independent dealers,
 * not guesses pulled from the air:
 *
 *   Turn      Used inventory at an independent turns in roughly 45 to 75 days for budget and
 *             mainstream stock, slower as the price climbs (premium 65-90, luxury 90-135, exotic
 *             150-240). Units a month = lot / days-to-turn x 30.
 *   Profit    Dealers make money on the spread, not the sticker: front-end gross per used unit
 *             runs about $1,500-$2,000 on budget cars, $1,900-$2,600 mainstream, $2,600-$3,600
 *             premium, $4,000-$7,000 luxury and $8,000-$15,000 on exotics. That spread is the
 *             dealer's commission on each sale; a salesperson typically keeps about a quarter of
 *             it, with a floor around $200.
 *   Lot       Very large stated totals usually cover a whole group or a listing feed, not one
 *             rooftop, so the lot-size method works from at most 300 vehicles and says so, and
 *             no single rooftop is credited with more than 150 sales a month.
 *   Measured  Once two inventory reads at least five days apart exist, listings that left the
 *             lot are counted as sold (scaled to the lot and to 30 days). That measured rate
 *             replaces the lot-size guess, bounded to a sane multiple of the segment band.
 *
 * Text here ends up in agent events; the local database is WIN1252-encoded, so plain hyphens
 * and no symbols outside that set.
 */
export type VolumeSnapshot = { capturedAt: Date; total: number | null; vdpUrls: string[]; medianPrice: number | null; prices?: number[] | null; newCount?: number | null; usedCount?: number | null; pricesHidden?: boolean | null };

export type Segment = "BUDGET" | "MAINSTREAM" | "PREMIUM" | "LUXURY" | "EXOTIC" | "UNKNOWN";

export type VolumeEstimate = {
  method: "TURNOVER" | "LOT_SIZE";
  confidence: "LOW" | "MEDIUM" | "HIGH";
  segment: Segment;
  onHand: number | null;
  /** The lot the estimate was worked from (capped when the stated total is implausible for one rooftop). */
  lotUsed: number;
  turnDaysLow: number;
  turnDaysHigh: number;
  unitsLow: number;
  unitsHigh: number;
  daysObserved: number;
  medianPrice: number | null;
  /** Sales volume: units x median asking price. Not profit. */
  grossLow: number | null;
  grossHigh: number | null;
  /** Front-end gross per unit for the segment (the dealer's commission on each sale), and the monthly total. */
  profitPerUnit: number | null;
  profitLow: number | null;
  profitHigh: number | null;
  /** What a salesperson typically keeps per sale. */
  commissionPerUnit: number | null;
  basis: string;
  assumptions: string[];
  /** The dealer hides prices online, so money figures cannot be read from its site. */
  pricesHidden: boolean;
};

const MIN_GAP_DAYS = 5;
const MIN_SAMPLE = 8;
const MIN_PRICES = 5;
/** Stated totals above this cover more than one rooftop in practice; the estimate works from this many. */
const MAX_LOT_FOR_ONE_ROOFTOP = 300;
/** No single independent rooftop is credited with more than this many sales a month. */
const MAX_UNITS_PER_MONTH = 150;
/** Marketing copy ("over 3,000 vehicles") rather than a lot: no estimate. */
const NOT_A_LOT = 1_500;
const SALESPERSON_SHARE = 0.25;
const SALESPERSON_MINIMUM = 200;

type Bench = { turnLow: number; turnHigh: number; profitLow: number; profitHigh: number; label: string };
export const SEGMENT_BENCHMARKS: Record<Segment, Bench> = {
  BUDGET: { turnLow: 45, turnHigh: 60, profitLow: 1_500, profitHigh: 2_000, label: "budget lot (median asking price under $12,000)" },
  MAINSTREAM: { turnLow: 55, turnHigh: 75, profitLow: 1_900, profitHigh: 2_600, label: "mainstream used (median $12,000 to $30,000)" },
  PREMIUM: { turnLow: 65, turnHigh: 90, profitLow: 2_600, profitHigh: 3_600, label: "premium used (median $30,000 to $60,000)" },
  LUXURY: { turnLow: 90, turnHigh: 135, profitLow: 4_000, profitHigh: 7_000, label: "luxury (median $60,000 to $120,000)" },
  EXOTIC: { turnLow: 150, turnHigh: 240, profitLow: 8_000, profitHigh: 15_000, label: "exotic and collector (median over $120,000)" },
  UNKNOWN: { turnLow: 55, turnHigh: 75, profitLow: 1_900, profitHigh: 2_600, label: "no asking prices read; mainstream turn assumed, no money figures" },
};

export function segmentFor(medianPrice: number | null): Segment {
  if (medianPrice === null) return "UNKNOWN";
  if (medianPrice < 12_000) return "BUDGET";
  if (medianPrice < 30_000) return "MAINSTREAM";
  if (medianPrice < 60_000) return "PREMIUM";
  if (medianPrice < 120_000) return "LUXURY";
  return "EXOTIC";
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

const quantile = (sorted: readonly number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))]!;

export const fmtUsd = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;
const round = (n: number) => Math.max(0, Math.round(n));

export function estimateVolume(input: readonly VolumeSnapshot[]): VolumeEstimate | null {
  const snaps = [...input].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
  if (snaps.length === 0) return null;
  const latest = snaps[snaps.length - 1]!;
  const onHand = latest.total ?? (latest.vdpUrls.length >= MIN_SAMPLE ? latest.vdpUrls.length : null);
  if (onHand === null || onHand <= 0 || onHand > NOT_A_LOT) return null;

  // What is on the lot: prices from the newest read that has enough of them.
  const priced = [...snaps].reverse().find((s) => (s.prices?.length ?? 0) >= MIN_PRICES || s.medianPrice !== null);
  const prices = priced?.prices?.length ? [...priced.prices].sort((a, b) => a - b) : [];
  const medianPrice = prices.length >= MIN_PRICES ? median(prices) : (priced?.medianPrice ?? null);
  const segment = segmentFor(medianPrice);
  const bench = SEGMENT_BENCHMARKS[segment];
  const assumptions: string[] = [];
  if (medianPrice !== null && prices.length >= MIN_PRICES) assumptions.push(`${prices.length} asking prices read: half the lot sits between ${fmtUsd(quantile(prices, 0.25))} and ${fmtUsd(quantile(prices, 0.75))}, median ${fmtUsd(medianPrice)}`);
  else if (medianPrice !== null) assumptions.push(`median asking price ${fmtUsd(medianPrice)} from a small sample`);
  else assumptions.push(latest.pricesHidden ? "this dealer does not list prices online (Contact Dealer), so sales and profit money figures are withheld" : "no asking prices could be read, so sales and profit money figures are withheld");
  assumptions.push(`${bench.label}: stock turns in about ${bench.turnLow}-${bench.turnHigh} days`);
  if (latest.newCount || latest.usedCount) assumptions.push(`${latest.usedCount ?? 0} used and ${latest.newCount ?? 0} new on the lot`);

  let lotUsed = onHand;
  if (onHand > MAX_LOT_FOR_ONE_ROOFTOP) {
    lotUsed = MAX_LOT_FOR_ONE_ROOFTOP;
    assumptions.push(`the site lists ${onHand} vehicles, more than one rooftop stocks (group or feed inventory); estimated as a ${MAX_LOT_FOR_ONE_ROOFTOP}-vehicle lot`);
  }

  // Turnover across every consecutive pair far enough apart to mean something.
  let unitsSum = 0;
  let daysSum = 0;
  let pairs = 0;
  for (let i = 1; i < snaps.length; i += 1) {
    const earlier = snaps[i - 1]!;
    const later = snaps[i]!;
    const days = (later.capturedAt.getTime() - earlier.capturedAt.getTime()) / 86_400_000;
    if (days < MIN_GAP_DAYS || earlier.vdpUrls.length < MIN_SAMPLE || later.vdpUrls.length < MIN_SAMPLE) continue;
    const now = new Set(later.vdpUrls);
    const gone = earlier.vdpUrls.filter((u) => !now.has(u)).length;
    const lot = Math.min(earlier.total ?? earlier.vdpUrls.length, MAX_LOT_FOR_ONE_ROOFTOP);
    unitsSum += (gone / earlier.vdpUrls.length) * lot;
    daysSum += days;
    pairs += 1;
  }

  const bandLow = (lotUsed / bench.turnHigh) * 30;
  const bandHigh = (lotUsed / bench.turnLow) * 30;
  let method: VolumeEstimate["method"] = "LOT_SIZE";
  let confidence: VolumeEstimate["confidence"] = "LOW";
  let unitsLow: number;
  let unitsHigh: number;
  let daysObserved = 0;
  let basis: string;

  if (daysSum >= MIN_GAP_DAYS) {
    method = "TURNOVER";
    daysObserved = Math.round(daysSum);
    const perMonth = (unitsSum / daysSum) * 30;
    // A measured rate far outside what the segment ever does is a sampling artefact (a relisted
    // feed, a page that reordered); keep it, but within a sane multiple of the band.
    const bounded = Math.min(Math.max(perMonth, bandLow * 0.5), bandHigh * 1.5);
    if (bounded !== perMonth) assumptions.push(`the measured rate (${round(perMonth)} a month) sits outside what this segment does; shown bounded to the segment band`);
    unitsLow = round(bounded * 0.85);
    unitsHigh = Math.max(unitsLow, round(bounded * 1.15));
    confidence = daysSum >= 28 ? "HIGH" : daysSum >= 14 ? "MEDIUM" : "LOW";
    basis = `${round(unitsSum)} listing(s) left the lot over ${daysObserved} day(s) across ${pairs} inventory comparison(s)`;
  } else {
    unitsLow = round(bandLow);
    unitsHigh = Math.max(unitsLow, round(bandHigh));
    basis = `${lotUsed} vehicles on the lot turning every ${bench.turnLow}-${bench.turnHigh} days; replaced by measured turnover once inventory reads a week apart exist`;
  }
  if (unitsHigh > MAX_UNITS_PER_MONTH) {
    assumptions.push(`capped at ${MAX_UNITS_PER_MONTH} a month: more than that is a multi-rooftop operation, not one independent store`);
    unitsHigh = MAX_UNITS_PER_MONTH;
    unitsLow = Math.min(unitsLow, round(MAX_UNITS_PER_MONTH * 0.75));
  }
  unitsLow = Math.max(unitsLow, lotUsed >= MIN_SAMPLE ? 1 : 0);

  const money = medianPrice !== null && segment !== "UNKNOWN";
  const profitPerUnit = money ? Math.round((bench.profitLow + bench.profitHigh) / 2) : null;
  const commissionPerUnit = profitPerUnit !== null ? Math.max(SALESPERSON_MINIMUM, Math.round(profitPerUnit * SALESPERSON_SHARE)) : null;
  if (profitPerUnit !== null) assumptions.push(`front-end gross about ${fmtUsd(bench.profitLow)}-${fmtUsd(bench.profitHigh)} per vehicle for this segment (the dealer's take on each sale); a salesperson keeps roughly a quarter, ${fmtUsd(commissionPerUnit!)} a car`);

  return {
    method,
    confidence,
    segment,
    onHand,
    lotUsed,
    turnDaysLow: bench.turnLow,
    turnDaysHigh: bench.turnHigh,
    unitsLow,
    unitsHigh,
    daysObserved,
    medianPrice,
    grossLow: money ? unitsLow * medianPrice! : null,
    grossHigh: money ? unitsHigh * medianPrice! : null,
    profitPerUnit,
    // Monthly profit follows the unit range at the segment's typical per-car gross, so the spread
    // reflects how many sell, not a compounding of two ranges.
    profitLow: money ? unitsLow * profitPerUnit! : null,
    profitHigh: money ? unitsHigh * profitPerUnit! : null,
    commissionPerUnit,
    basis,
    assumptions,
    pricesHidden: medianPrice === null && Boolean(latest.pricesHidden),
  };
}

export const SEGMENT_LABEL: Record<Segment, string> = { BUDGET: "Budget", MAINSTREAM: "Mainstream", PREMIUM: "Premium", LUXURY: "Luxury", EXOTIC: "Exotic", UNKNOWN: "Unpriced" };

const short = (n: number) => (n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `$${Math.round(n / 1_000)}k` : fmtUsd(n));

/** One line for feeds and briefs. */
export function describeVolume(v: VolumeEstimate): string {
  const units = v.unitsLow === v.unitsHigh ? `about ${v.unitsLow}` : `about ${v.unitsLow}-${v.unitsHigh}`;
  const profit = v.profitLow !== null && v.profitHigh !== null ? `, roughly ${short(v.profitLow)}-${short(v.profitHigh)} gross profit (${fmtUsd(v.profitPerUnit!)} a car)` : "";
  return `${units} vehicles a month${profit}, ${v.method === "TURNOVER" ? `measured over ${v.daysObserved} days` : "from lot size"} · ${v.confidence.toLowerCase()} confidence`;
}
