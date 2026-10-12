import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { dealerGroups, dealerships, salesBriefs, scores, signals, testInteractions, websiteObservations, type ScoreReason } from "@/db/schema";
import type { PipelineStage, Product } from "@/domain/constants";
import { assessFit, deriveChecks, type Checks, type Fit } from "@/domain/checks";
import { GROWTH_SIGNAL_TYPES } from "@/domain/constants";
import { responses } from "@/db/schema";

export type OpportunityRow = {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  brands: string[];
  groupId: string | null;
  groupName: string | null;
  priority: number;
  overridden: boolean;
  recommendedProduct: Product | null;
  topReason: ScoreReason | null;
  scores: Partial<Record<Product, number>>;
  inventoryCount: number | null;

  estimate: { unitsLow: number; unitsHigh: number; grossLow: number | null; grossHigh: number | null; profitLow: number | null; profitHigh: number | null; confidence: string } | null;
  firstResponseSeconds: number | null;
  lastTestedAt: Date | null;
  hiring: boolean;
  technology: string[];
  suppressed: boolean;
  paused: boolean;
  pipelineStage: PipelineStage;
  nextAction: string | null;
  lastChecked: Date | null;
  salesAngle: string | null;
  recommendedRole: string | null;
  checks: Checks;
  fit: Fit;
  phone: string | null;
  domain: string | null;
};

export type OpportunityFilters = {
  state?: string;
  city?: string;
  brand?: string;
  groupId?: string;
  product?: Product;
  minScore?: number;
  minInventory?: number;
  response?: "none" | "slow" | "fast" | "untested";
  tested?: "never" | "30d" | "older";
  hiring?: boolean;
  technology?: string;
  suppression?: "active" | "suppressed" | "all";
};

/** Effective priority: an operator's manual override wins over the computed score. */
const effectivePriority = sql<number>`coalesce(${dealerships.priorityOverride}, ${dealerships.priorityScore})`;

export async function listOpportunities(filters: OpportunityFilters = {}, limit = 500): Promise<OpportunityRow[]> {
  const where = [];
  if (filters.state) where.push(eq(dealerships.state, filters.state.toUpperCase()));
  if (filters.city) where.push(sql`lower(${dealerships.city}) = ${filters.city.toLowerCase()}`);
  if (filters.groupId) where.push(eq(dealerships.groupId, filters.groupId));
  if (filters.product) where.push(eq(dealerships.recommendedProduct, filters.product));
  if (filters.minScore) where.push(gte(effectivePriority, filters.minScore));
  if (filters.minInventory) where.push(gte(dealerships.inventoryCount, filters.minInventory));
  const suppression = filters.suppression ?? "active";
  if (suppression !== "all") where.push(eq(dealerships.suppressed, suppression === "suppressed"));

  const rows = await db()
    .select({ d: dealerships, groupName: dealerGroups.name, priority: effectivePriority })
    .from(dealerships)
    .leftJoin(dealerGroups, eq(dealerGroups.id, dealerships.groupId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(effectivePriority), dealerships.name)
    .limit(2000);
  const ids = rows.map((r) => r.d.id);
  if (ids.length === 0) return [];

  const [scoreRows, interactions, hiring, observations, briefs] = await Promise.all([
    db().select().from(scores).where(inArray(scores.dealershipId, ids)),
    db()
      .select({ id: testInteractions.id, dealershipId: testInteractions.dealershipId, submittedAt: testInteractions.submittedAt, first: testInteractions.firstResponseSeconds, status: testInteractions.status })
      .from(testInteractions)
      .where(and(inArray(testInteractions.dealershipId, ids), eq(testInteractions.testType, "FORM"), isNotNull(testInteractions.submittedAt)))
      .orderBy(desc(testInteractions.submittedAt)),
    db()
      .select({ dealershipId: signals.dealershipId, title: signals.title })
      .from(signals)
      .where(and(inArray(signals.dealershipId, ids), inArray(signals.type, [...GROWTH_SIGNAL_TYPES]), gte(signals.detectedAt, new Date(Date.now() - 60 * 86_400_000)))),
    db()
      .select({
        dealershipId: websiteObservations.dealershipId,
        tech: websiteObservations.detectedTechnology,
        websiteStatus: websiteObservations.websiteStatus,
        statusDetail: websiteObservations.statusDetail,
        chatPresent: websiteObservations.chatPresent,
        chatVendor: websiteObservations.chatVendor,
        chatType: websiteObservations.chatType,
        chatWorking: websiteObservations.chatWorking,
        chatQuality: websiteObservations.chatQuality,
        leadFormCount: websiteObservations.leadFormCount,
      })
      .from(websiteObservations)
      .where(inArray(websiteObservations.dealershipId, ids))
      .orderBy(desc(websiteObservations.timestamp)),
    db()
      .select({ dealershipId: salesBriefs.dealershipId, salesAngle: salesBriefs.salesAngle, roles: salesBriefs.recommendedRoles })
      .from(salesBriefs)
      .where(inArray(salesBriefs.dealershipId, ids))
      .orderBy(desc(salesBriefs.generatedAt)),
  ]);
  const first = <T extends { dealershipId: string | null }>(list: T[]) => {
    const m = new Map<string, T>();
    for (const x of list) if (x.dealershipId && !m.has(x.dealershipId)) m.set(x.dealershipId, x);
    return m;
  };
  const lastTest = first(interactions);
  const tech = first(observations);
  const brief = first(briefs);
  const testIds = [...lastTest.values()].map((t) => t.id);
  const responseRows = testIds.length
    ? await db().select({ interactionId: responses.interactionId, channel: responses.channel, responseSeconds: responses.responseSeconds, humanOrAutomation: responses.humanOrAutomation }).from(responses).where(inArray(responses.interactionId, testIds))
    : [];
  const hiringSet = new Set(hiring.map((h) => h.dealershipId));
  const growthTitles = new Map<string, string[]>();
  for (const h of hiring) if (h.dealershipId) growthTitles.set(h.dealershipId, [...(growthTitles.get(h.dealershipId) ?? []), h.title]);

  const out: OpportunityRow[] = rows.map(({ d, groupName, priority }) => {
    const own = scoreRows.filter((s) => s.dealershipId === d.id);
    const top = d.recommendedProduct ? own.find((s) => s.product === d.recommendedProduct) : undefined;
    const topReason = top ? ([...top.reasons].sort((a, b) => b.points - a.points)[0] ?? null) : null;
    const test = lastTest.get(d.id);
    const obs = tech.get(d.id);
    const checks = deriveChecks({
      dealership: d,
      observation: obs ? { websiteStatus: obs.websiteStatus, statusDetail: obs.statusDetail, chatPresent: obs.chatPresent, chatVendor: obs.chatVendor, chatType: obs.chatType, leadFormCount: obs.leadFormCount, detectedTechnology: obs.tech } : null,
      interaction: test ? { status: test.status, submittedAt: test.submittedAt, firstResponseSeconds: test.first } : null,
      responses: test ? responseRows.filter((r) => r.interactionId === test.id) : [],
    });
    const fit = assessFit(checks, {
      chatWorking: obs?.chatWorking ?? null,
      chatQuality: obs?.chatQuality ?? null,
      leadFormCount: obs?.websiteStatus === "OK" ? obs.leadFormCount : null,
      siteReadable: obs?.websiteStatus === "OK",
      growthHiring: growthTitles.get(d.id) ?? [],
    });
    return {
      checks,
      fit,
      phone: d.phone,
      domain: d.normalizedDomain,
      id: d.id,
      name: d.name,
      city: d.city,
      state: d.state,
      brands: d.brands,
      groupId: d.groupId,
      groupName,
      priority: Number(priority),
      overridden: d.priorityOverride !== null,
      recommendedProduct: d.recommendedProduct,
      topReason,
      scores: Object.fromEntries(own.map((s) => [s.product, s.score])),
      inventoryCount: d.inventoryCount,

      estimate: d.estUnitsLow !== null ? { unitsLow: d.estUnitsLow, unitsHigh: d.estUnitsHigh ?? d.estUnitsLow, grossLow: d.estGrossLow, grossHigh: d.estGrossHigh, profitLow: d.estProfitLow, profitHigh: d.estProfitHigh, confidence: d.estConfidence ?? "LOW" } : null,
      firstResponseSeconds: test?.first ?? null,
      lastTestedAt: test?.submittedAt ?? null,
      hiring: hiringSet.has(d.id),
      technology: (obs?.websiteStatus === "OK" ? (obs.tech ?? []) : []).map((t) => t.name),
      suppressed: d.suppressed,
      paused: d.paused,
      pipelineStage: d.pipelineStage,
      nextAction: d.nextAction,
      lastChecked: d.lastChecked,
      salesAngle: brief.get(d.id)?.salesAngle ?? null,
      recommendedRole: brief.get(d.id)?.roles[0] ?? null,
    };
  });

  const now = Date.now();
  return out
    .filter((r) => {
      if (filters.brand && !r.brands.some((b) => b.toLowerCase() === filters.brand!.toLowerCase())) return false;
      if (filters.technology && !r.technology.some((t) => t.toLowerCase().includes(filters.technology!.toLowerCase()))) return false;
      if (filters.hiring && !r.hiring) return false;
      if (filters.response === "untested" && r.lastTestedAt) return false;
      if (filters.response === "none" && !(r.lastTestedAt && r.firstResponseSeconds === null)) return false;
      if (filters.response === "slow" && !(r.firstResponseSeconds !== null && r.firstResponseSeconds > 900)) return false;
      if (filters.response === "fast" && !(r.firstResponseSeconds !== null && r.firstResponseSeconds <= 900)) return false;
      const age = r.lastTestedAt ? (now - r.lastTestedAt.getTime()) / 86_400_000 : null;
      if (filters.tested === "never" && age !== null) return false;
      if (filters.tested === "30d" && !(age !== null && age <= 30)) return false;
      if (filters.tested === "older" && !(age !== null && age > 30)) return false;
      return true;
    })
    .slice(0, limit);
}
