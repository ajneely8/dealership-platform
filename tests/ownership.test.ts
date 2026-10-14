import { describe, expect, it } from "vitest";
import { classifyOwnership, isFranchise, queueEligible, researchQueueEligible } from "@/domain/ownership";

const base = { name: "Lakeside Auto Sales", domain: "lakesideautosales.com", brands: [] as string[] };

describe("ownership classification", () => {
  it("excludes franchise stores and national chains before reading anything", () => {
    expect(classifyOwnership({ ...base, name: "Lakeside Ford", text: "family owned since 1950" }).status).toBe("EXCLUDED");
    expect(classifyOwnership({ ...base, brands: ["Toyota"], text: "" }).status).toBe("EXCLUDED");
    expect(classifyOwnership({ ...base, domain: "carmax.com", text: "" }).status).toBe("EXCLUDED");
    expect(isFranchise({ name: "Ingram Motors", domain: "ingrammotors.com" })).toBe(false);
  });

  it("verifies family ownership only from a statement, never from size", () => {
    const r = classifyOwnership({ ...base, text: "Welcome to Lakeside. We are a family owned and operated dealership serving Austin since 1987. Browse our inventory." });
    expect(r.status).toBe("FAMILY_OWNED_INDEPENDENT");
    expect(r.quote).toMatch(/family owned and operated dealership serving Austin since 1987/);
    expect(r.confidence).toBe("HIGH");
    expect(classifyOwnership({ ...base, text: "Great cars at great prices. 12 vehicles in stock." }).status).toBe("UNVERIFIED");
  });

  it("separates privately owned from family-owned, and reads corporate ownership as excluded", () => {
    expect(classifyOwnership({ ...base, text: "We are a locally owned independent dealer." }).status).toBe("PRIVATELY_OWNED_INDEPENDENT");
    expect(classifyOwnership({ ...base, text: "Lakeside is a subsidiary of Northstar Holdings, a publicly traded company." }).status).toBe("EXCLUDED");
  });

  it("gates the queues", () => {
    expect(queueEligible("FAMILY_OWNED_INDEPENDENT")).toBe(true);
    expect(queueEligible("PRIVATELY_OWNED_INDEPENDENT")).toBe(false);
    expect(researchQueueEligible("PRIVATELY_OWNED_INDEPENDENT")).toBe(true);
    expect(researchQueueEligible("UNVERIFIED")).toBe(true);
    expect(researchQueueEligible("EXCLUDED")).toBe(false);
  });
});

describe("ownership evidence quality", () => {
  it("ignores customer reviews that mention family", () => {
    expect(classifyOwnership({ ...base, text: "Reviews. This was the second vehicle our family has purchased from Lakeside and will not be the last. 5 stars." }).status).toBe("UNVERIFIED");
    expect(classifyOwnership({ ...base, text: "They are a great father and son team, very helpful. I bought my truck here." }).status).toBe("UNVERIFIED");
  });

  it("keeps the matched phrase inside the quote even in long navigation text", () => {
    const nav = Array.from({ length: 40 }, (_, i) => `Menu item ${i} Inventory Financing`).join(" ");
    const r = classifyOwnership({ ...base, text: `${nav} Family Owned And Operated For Over 40 years ${nav}` });
    expect(r.status).toBe("FAMILY_OWNED_INDEPENDENT");
    expect(r.quote).toMatch(/Family Owned And Operated/i);
    expect((r.quote ?? "").length).toBeLessThanOrEqual(240);
  });
});
