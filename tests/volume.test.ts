import { describe, expect, it } from "vitest";
import { describeVolume, estimateVolume, median, segmentFor } from "@/domain/volume";

const day = 86_400_000;
const urls = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `https://d.example/vehicle/${from + i}`);
const spread = (n: number, around: number) => Array.from({ length: n }, (_, i) => around + (i - n / 2) * 500);

describe("Sentinel's volume and profit model", () => {
  it("is null with nothing to go on, or with a marketing number for a lot", () => {
    expect(estimateVolume([])).toBeNull();
    expect(estimateVolume([{ capturedAt: new Date(), total: null, vdpUrls: urls(3), medianPrice: null }])).toBeNull();
    expect(estimateVolume([{ capturedAt: new Date(), total: 10_000, vdpUrls: urls(20), medianPrice: 15_000 }])).toBeNull();
  });

  it("segments by median asking price", () => {
    expect(segmentFor(null)).toBe("UNKNOWN");
    expect(segmentFor(9_000)).toBe("BUDGET");
    expect(segmentFor(18_000)).toBe("MAINSTREAM");
    expect(segmentFor(45_000)).toBe("PREMIUM");
    expect(segmentFor(75_000)).toBe("LUXURY");
    expect(segmentFor(250_000)).toBe("EXOTIC");
  });

  it("gives a mainstream lot a realistic first guess with profit per car", () => {
    // 40 cars around $18k: 55-75 day turn → 16-22 a month; $1,900-$2,600 front gross a car.
    const v = estimateVolume([{ capturedAt: new Date(), total: 40, vdpUrls: urls(20), medianPrice: null, prices: spread(20, 18_000), usedCount: 40 }])!;
    expect(v.method).toBe("LOT_SIZE");
    expect(v.segment).toBe("MAINSTREAM");
    expect(v.unitsLow).toBe(16);
    expect(v.unitsHigh).toBe(22);
    expect(v.profitPerUnit).toBe(2_250);
    expect(v.commissionPerUnit).toBe(563);
    expect(v.profitLow).toBe(16 * 2_250);
    expect(v.profitHigh).toBe(22 * 2_250);
    expect(v.grossLow).toBe(16 * v.medianPrice!);
    expect(v.assumptions.join(" ")).toMatch(/40 used/);
    expect(describeVolume(v)).toMatch(/about 16-22 vehicles a month, roughly \$36k-\$50k gross profit \(\$2,250 a car\), from lot size/);
  });

  it("turns exotic stock slowly and never credits a rooftop with group-sized volume", () => {
    const exotic = estimateVolume([{ capturedAt: new Date(), total: 210, vdpUrls: urls(40), medianPrice: null, prices: spread(40, 250_000) }])!;
    expect(exotic.segment).toBe("EXOTIC");
    expect(exotic.unitsLow).toBe(26); // 210 / 240 × 30
    expect(exotic.unitsHigh).toBe(42); // 210 / 150 × 30
    const group = estimateVolume([{ capturedAt: new Date(), total: 1_439, vdpUrls: urls(77), medianPrice: 12_877 }])!;
    expect(group.lotUsed).toBe(300);
    expect(group.unitsHigh).toBeLessThanOrEqual(150);
    expect(group.assumptions.join(" ")).toMatch(/more than one rooftop/);
  });

  it("withholds money figures when no prices were read", () => {
    const v = estimateVolume([{ capturedAt: new Date(), total: 30, vdpUrls: urls(12), medianPrice: null }])!;
    expect(v.segment).toBe("UNKNOWN");
    expect(v.unitsLow).toBe(12);
    expect(v.grossLow).toBeNull();
    expect(v.profitLow).toBeNull();
    expect(v.commissionPerUnit).toBeNull();
  });

  it("measures turnover once reads are at least five days apart and bounds it to the segment", () => {
    const t0 = new Date("2026-10-01T12:00:00Z");
    // 40 on the lot, 20 sampled; a week later 5 of 20 are gone → 25% of 40 = 10 in 7 days ≈ 43 a month,
    // more than a 40-car mainstream lot does (band 16-22), so it is bounded to 1.5 × 22 = 33.
    const v = estimateVolume([
      { capturedAt: t0, total: 40, vdpUrls: urls(20), medianPrice: 18_000 },
      { capturedAt: new Date(t0.getTime() + 7 * day), total: 40, vdpUrls: [...urls(15, 5), ...urls(5, 100)], medianPrice: 18_000 },
    ])!;
    expect(v.method).toBe("TURNOVER");
    expect(v.daysObserved).toBe(7);
    expect(v.confidence).toBe("LOW");
    expect(v.unitsHigh).toBe(38); // 33 × 1.15
    expect(v.assumptions.join(" ")).toMatch(/bounded/);
  });

  it("gains confidence with a longer window and skips reads too close together", () => {
    const t0 = new Date("2026-10-01T12:00:00Z");
    const v = estimateVolume([
      { capturedAt: t0, total: 30, vdpUrls: urls(30), medianPrice: 20_000 },
      { capturedAt: new Date(t0.getTime() + 1 * day), total: 30, vdpUrls: urls(30), medianPrice: 20_000 },
      { capturedAt: new Date(t0.getTime() + 15 * day), total: 30, vdpUrls: [...urls(24, 6), ...urls(6, 200)], medianPrice: 20_000 },
      { capturedAt: new Date(t0.getTime() + 30 * day), total: 30, vdpUrls: [...urls(18, 12), ...urls(12, 300)], medianPrice: 20_000 },
    ])!;
    expect(v.method).toBe("TURNOVER");
    expect(v.daysObserved).toBe(29);
    expect(v.confidence).toBe("HIGH");
  });

  it("takes the median of asking prices", () => {
    expect(median([])).toBeNull();
    expect(median([9_000, 25_000, 12_000])).toBe(12_000);
    expect(median([9_000, 25_000, 12_000, 14_000])).toBe(13_000);
  });
});
