import { createHash } from "node:crypto";
import { storeOwnership } from "@/lib/ownership-store";
import { classifyOwnership } from "@/domain/ownership";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { dealerGroups, dealerships, evidence, inventorySnapshots, signals, socialProfiles, websiteObservations, type DetectedForm, type VisitedPage } from "@/db/schema";
import { fmtUsd, median } from "@/domain/volume";
import type { EvidenceType } from "@/domain/constants";
import { audit } from "@/lib/audit";
import { saveScreenshot } from "@/lib/evidence";
import { formatPhone, isPlaceholderName, normalizeAddress, normalizeName, normalizePhone } from "@/lib/normalize";
import { getSettings } from "@/lib/settings";
import { Crawler, type Visit } from "./crawler";
import { emit } from "@/lib/agent-events";
import {
  classifyForms,
  combineInventory,
  dedupeForms,
  detectChat,
  detectInventoryAlerts,
  detectService,
  detectTechnology,
  extractDealerInfo,
  extractHiringSignals,
  extractSocialLinks,
  findLinks,
  LEAD_FORM_TYPES,
  pickInventoryPages,
  readInventory,
  type HiringSignal,
  type InventoryRead,
  extractPrices,
} from "./detect";
import { checkMobileFriendly, type PageSnapshot } from "./snapshot";

type Shot = { type: EvidenceType; body: Buffer; sourceUrl: string };

async function loadTarget(dealershipId: string) {
  const [d] = await db().select().from(dealerships).where(eq(dealerships.id, dealershipId)).limit(1);
  if (!d) throw new Error(`Dealership ${dealershipId} not found`);
  return d;
}

function addDays(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

/**
 * Visits the homepage. Many dealer sites only answer properly on one of "www." / bare domain
 * (certificate or DNS covers just one), so when the address on file fails that way the other
 * form is tried once and, if it works, saved as the dealership's website.
 */
async function visitHome(crawler: Crawler, dealer: { id: string; website: string }): Promise<Visit> {
  const first = await crawler.visit(dealer.website, "HOMEPAGE");
  if (first.snapshot || first.page.outcome !== "ERROR") return first;
  if (!/ERR_CERT_COMMON_NAME_INVALID|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_(REFUSED|RESET|CLOSED)|ERR_SSL/.test(first.page.detail ?? "")) return first;
  const alt = new URL(dealer.website);
  if (!alt.hostname.includes(".") || /^\d+\.\d+\.\d+\.\d+$/.test(alt.hostname)) return first;
  alt.hostname = alt.hostname.startsWith("www.") ? alt.hostname.slice(4) : `www.${alt.hostname}`;
  const second = await crawler.visit(alt.toString(), "HOMEPAGE");
  if (!second.snapshot) return first;
  const website = alt.toString().replace(/\/$/, "");
  await db().update(dealerships).set({ website, updatedAt: new Date() }).where(eq(dealerships.id, dealer.id));
  await audit("system:website", "dealership.updated", "dealership", dealer.id, { fields: ["website"], from: dealer.website, to: website, reason: first.page.detail });
  return second;
}

async function persistInventory(dealershipId: string, reads: { segment: "NEW" | "USED" | "ALL"; read: InventoryRead; url: string }[]): Promise<number | null> {
  if (reads.length === 0) return null;
  const combined = combineInventory(reads);
  await db().insert(inventorySnapshots).values({
    dealershipId,
    total: combined.total,
    newCount: combined.newCount,
    usedCount: combined.usedCount,
    method: combined.method,
    confidence: combined.confidence,
    vdpUrls: combined.vdpUrls,
    prices: combined.prices,
    medianPrice: median(combined.prices),
    pricesHidden: combined.hidesPrices,
    sourceUrls: reads.map((r) => r.url),
  });
  if (combined.total !== null) await db().update(dealerships).set({ inventoryCount: combined.total }).where(eq(dealerships.id, dealershipId));
  if (combined.prices.length) await emit(`Asking prices read: ${combined.prices.length}, median ${fmtUsd(median(combined.prices)!)}`, { status: "DONE", kind: "finding.created" });
  else await emit(combined.hidesPrices ? "This dealer does not list prices online (Contact Dealer)" : "No asking prices could be read on the inventory pages", { status: "INFO", kind: "finding.created" });
  return combined.total;
}

async function persistHiringSignals(dealershipId: string, groupId: string | null, found: HiringSignal[], sourceUrl: string): Promise<number> {
  const now = new Date();
  for (const s of found) {
    const dedupeKey = createHash("sha1").update(`${dealershipId}|${s.type}|${s.title.toLowerCase()}`).digest("hex");
    await db()
      .insert(signals)
      .values({
        dealershipId,
        groupId,
        type: s.type,
        title: s.title,
        description: "Open position listed on the dealership's careers page.",
        sourceUrl,
        confidence: s.confidence,
        kind: "OBSERVED",
        source: "CAREERS_PAGE",
        dedupeKey,
        detectedAt: now,
        lastSeenAt: now,
      })
      // Seen again: keep the original detection date, just refresh lastSeenAt.
      .onConflictDoUpdate({ target: signals.dedupeKey, set: { lastSeenAt: now, sourceUrl } });
  }
  return found.length;
}

/**
 * Full passive scan of one dealership website. Collects structured facts and screenshots only —
 * it never fills in or submits anything.
 */
export async function runWebsiteScan(dealershipId: string): Promise<string> {
  const dealer = await loadTarget(dealershipId);
  if (!dealer.website) return "SKIPPED: no website on file";
  if (dealer.paused) return "SKIPPED: dealership is paused";
  const settings = await getSettings();

  const crawler = await Crawler.open({ present: settings.researchPresentation });
  const pages: VisitedPage[] = [];
  const shots: Shot[] = [];
  const snapshots: { kind: VisitedPage["kind"]; snapshot: PageSnapshot }[] = [];

  const PAGE_LABEL: Record<VisitedPage["kind"], string> = { HOMEPAGE: "homepage", INVENTORY: "inventory page", VDP: "vehicle page", CONTACT: "contact page", SERVICE: "service page", SCHEDULER: "service scheduler", CAREERS: "careers page", ABOUT: "about page" };
  const visit = async (url: string, kind: VisitedPage["kind"], shot?: EvidenceType): Promise<PageSnapshot | null> => {
    const v = await crawler.visit(url, kind);
    pages.push(v.page);
    if (!v.snapshot) {
      await emit(`Could not read the ${PAGE_LABEL[kind]}`, { detail: `${v.page.outcome}${v.page.detail ? `: ${v.page.detail}` : ""} — ${url}`, status: v.page.outcome === "BLOCKED" || v.page.outcome === "ROBOTS_DISALLOWED" ? "BLOCKED" : "ERROR" });
      return null;
    }
    await emit(`Opened the ${PAGE_LABEL[kind]}`, { detail: v.snapshot.url });
    snapshots.push({ kind, snapshot: v.snapshot });
    if (shot) {
      shots.push({ type: shot, body: await crawler.screenshot(), sourceUrl: v.snapshot.url });
      await emit(`Screenshot captured: ${PAGE_LABEL[kind]}`);
    }
    return v.snapshot;
  };

  try {
    const homeVisit = await visitHome(crawler, { id: dealer.id, website: dealer.website });
    pages.push(homeVisit.page);
    const home = homeVisit.snapshot;
    if (home) {
      snapshots.push({ kind: "HOMEPAGE", snapshot: home });
      shots.push({ type: "HOMEPAGE", body: await crawler.screenshot(), sourceUrl: home.url });
    }
    if (!home) {
      const first = pages[0]!;
      const status = first.outcome === "BLOCKED" ? "BLOCKED" : first.outcome === "ROBOTS_DISALLOWED" ? "ROBOTS_DISALLOWED" : first.httpStatus ? "ERROR" : "UNREACHABLE";
      await db().insert(websiteObservations).values({ dealershipId, websiteStatus: status, statusDetail: first.detail ?? null, pages });
      await db()
        .update(dealerships)
        .set({ lastChecked: new Date(), nextCheck: addDays(settings.websiteScanIntervalDays), updatedAt: new Date() })
        .where(eq(dealerships.id, dealershipId));
      return `${status}: ${first.detail ?? "homepage could not be read"}`;
    }
    const mobileFriendly = await checkMobileFriendly(crawler.page).catch(() => null);
    await emit(mobileFriendly === null ? "Mobile check could not run" : mobileFriendly ? "Mobile experience checked: fits a phone screen" : "Mobile experience checked: sideways scrolling or no viewport tag", { status: mobileFriendly === false ? "INFO" : "DONE" });
    const links = findLinks(home);

    // --- Inventory listing pages, then one vehicle detail page -------------
    const inventoryReads: { segment: "NEW" | "USED" | "ALL"; read: InventoryRead; url: string }[] = [];
    // New and used listings both count toward inventory; the about page is skipped to keep scans quick.
    for (const target of pickInventoryPages(links.INVENTORY ?? [])) {
      const snap = await visit(target.url, "INVENTORY", inventoryReads.length === 0 ? "INVENTORY" : undefined);
      if (snap) inventoryReads.push({ segment: target.segment, read: readInventory(snap), url: snap.url });
    }
    const vdpUrl = inventoryReads.flatMap((r) => r.read.vdpUrls)[0];
    const vdpSnap = vdpUrl ? await visit(vdpUrl, "VDP", "FORM") : null;
    // Listing pages that show no prices often do on the vehicle page itself; look at a couple.
    if (inventoryReads.length && inventoryReads.flatMap((r) => r.read.prices).length < 5) {
      const extra = vdpSnap ? extractPrices(vdpSnap) : [];
      for (const u of inventoryReads.flatMap((r) => r.read.vdpUrls).slice(1, 3)) {
        const s = await crawler.visit(u, "VDP");
        if (s.snapshot) extra.push(...extractPrices(s.snapshot));
      }
      if (extra.length) {
        inventoryReads[0]!.read.prices.push(...extra);
        inventoryReads[0]!.read.hidesPrices = false;
        await emit(`Asking prices read from ${Math.min(3, inventoryReads.flatMap((r) => r.read.vdpUrls).length)} vehicle page(s): the listing hides them`, { status: "DONE", kind: "finding.created" });
      }
    }

    // --- Contact, service, scheduler, careers ---------------------------------
    if (links.CONTACT?.[0]) await visit(links.CONTACT[0], "CONTACT", vdpUrl ? undefined : "FORM");
    const servicePage = links.SERVICE?.[0] ? await visit(links.SERVICE[0], "SERVICE", "SERVICE") : null;
    const schedulerLink = links.SCHEDULER?.[0] ?? null;
    const schedulerPage = schedulerLink ? await visit(schedulerLink, "SCHEDULER", servicePage ? undefined : "SERVICE") : null;
    const careersUrl = links.CAREERS?.[0] ?? null;
    const careersPage = careersUrl ? await visit(careersUrl, "CAREERS") : null;
    // Ownership: what the dealership says about itself on its About page (or homepage).
    {
      const aboutUrl = links.ABOUT?.[0] ?? null;
      const aboutPage = aboutUrl ? await visit(aboutUrl, "ABOUT") : null;
      const [who] = await db().select({ name: dealerships.name, brands: dealerships.brands, domain: dealerships.normalizedDomain }).from(dealerships).where(eq(dealerships.id, dealer.id)).limit(1);
      if (who) {
        const text = `${aboutPage?.text ?? ""}\n${home.text}`;
        const ownership = classifyOwnership({ name: who.name, domain: who.domain, brands: who.brands, text });
        await storeOwnership(dealer.id, ownership, { url: ownership.status === "UNVERIFIED" ? null : (aboutPage?.url ?? home.url), by: "system:website" });
      }
    }

    // --- Turn snapshots into findings (pure functions) -------------------------
    const all = snapshots.map((s) => s.snapshot);
    const chat = detectChat(all);
    await emit(chat.present ? `Chat widget detected: ${chat.vendor ?? "unrecognised vendor"}` : "No chat widget found", { detail: chat.evidence, status: chat.present ? "DONE" : "INFO", kind: "finding.created" });
    const forms = dedupeForms(snapshots.flatMap((s) => classifyForms(s.snapshot, s.kind)));
    const leadForms: DetectedForm[] = forms.filter((f) => LEAD_FORM_TYPES.includes(f.type));
    await emit(`Lead forms found: ${leadForms.length}`, { detail: leadForms.map((f) => `${f.type} (${f.fields.length} fields)`).join(", ") || null, status: "DONE", kind: "finding.created" });
    const serviceSnaps = [servicePage, schedulerPage].filter((p): p is PageSnapshot => p !== null);
    const service = detectService({
      servicePage,
      schedulerPage,
      schedulerLink,
      serviceForms: serviceSnaps.flatMap((s) => classifyForms(s, "SERVICE")),
      chatOnServicePage: serviceSnaps.length > 0 && detectChat(serviceSnaps).present,
    });
    const combined = inventoryReads.length ? combineInventory(inventoryReads) : null;
    await emit(combined?.total !== null && combined?.total !== undefined ? `Inventory counted: ${combined.total} vehicles` : inventoryReads.length ? "Inventory page read, total not stated" : "No inventory page found", { status: combined ? "DONE" : "INFO", kind: "finding.created" });
    await emit(service.present ? `Service checked: ${service.details?.schedulerMode === "NONE" ? "no online scheduler" : service.details?.schedulerMode === "UNRECOGNISED" ? "scheduler of unknown type" : service.details?.schedulerMode === "FORM_ONLY" ? "request form only" : `online scheduler${service.schedulerVendor ? ` (${service.schedulerVendor})` : ""}`}` : "No service page found", { status: service.present ? "DONE" : "INFO", kind: "finding.created" });
    const inventorySnaps = snapshots.filter((s) => s.kind === "INVENTORY" || s.kind === "VDP").map((s) => s.snapshot);
    const social = extractSocialLinks(all);
    const hiring = careersPage ? extractHiringSignals(careersPage) : [];
    const blockedPages = pages.filter((p) => p.outcome !== "OK");

    const [obs] = await db()
      .insert(websiteObservations)
      .values({
        dealershipId,
        websiteStatus: "OK",
        mobileFriendly,
        chatPresent: chat.present,
        chatVendor: chat.vendor,
        chatType: chat.chatType,
        leadFormPresent: leadForms.length > 0,
        leadFormCount: leadForms.length,
        leadForms: forms.filter((f) => f.type !== "SEARCH" && f.type !== "OTHER"),
        inventoryPagePresent: inventoryReads.length > 0,
        inventoryCount: combined?.total ?? null,
        // Only assert "no alerts" when we actually looked at inventory pages.
        inventoryAlertsPresent: inventorySnaps.length ? detectInventoryAlerts([home, ...inventorySnaps]) : null,
        servicePagePresent: service.present,
        serviceSchedulerPresent: service.schedulerPresent,
        serviceSchedulerVendor: service.schedulerVendor,
        service: service.details,
        socialLinks: social,
        detectedTechnology: detectTechnology(all),
        careersUrl: careersPage?.url ?? careersUrl,
        pages,
        notes: blockedPages.length ? `${blockedPages.length} page(s) could not be read: ${blockedPages.map((p) => `${p.kind} (${p.outcome})`).join(", ")}` : null,
      })
      .returning({ id: websiteObservations.id });
    if (!obs) throw new Error("Failed to store observation");

    for (const s of shots) {
      const saved = await saveScreenshot({ dealershipId, type: s.type, body: s.body, sourceUrl: s.sourceUrl, observationId: obs.id });
      await emit(`Screenshot saved: ${s.type.toLowerCase()}`, { evidenceId: saved.id, detail: s.sourceUrl, status: "DONE" });
    }
    await emit("Findings saved", { detail: `${social.length} social profile(s), ${hiring.length} hiring signal(s)`, status: "DONE", kind: "finding.created" });

    await persistInventory(dealershipId, inventoryReads);
    const now = new Date();
    for (const s of social) {
      await db()
        .insert(socialProfiles)
        .values({ dealershipId, platform: s.platform, url: s.url })
        .onConflictDoUpdate({ target: [socialProfiles.dealershipId, socialProfiles.platform, socialProfiles.url], set: { lastSeen: now } });
    }
    if (careersPage) await persistHiringSignals(dealershipId, dealer.groupId, hiring, careersPage.url);

    await db()
      .update(dealerships)
      .set({ lastChecked: now, nextCheck: addDays(settings.websiteScanIntervalDays), updatedAt: now })
      .where(eq(dealerships.id, dealershipId));

    return `OK: ${pages.filter((p) => p.outcome === "OK").length} pages, ${leadForms.length} lead forms, chat ${chat.present ? (chat.vendor ?? "unknown vendor") : "none"}, inventory ${combined?.total ?? "n/a"}, ${hiring.length} hiring signals`;
  } finally {
    await crawler.close();
  }
}

/** Lighter job for the 3–7 day inventory cadence: homepage + listing pages only. */
export async function runInventoryScan(dealershipId: string): Promise<string> {
  const dealer = await loadTarget(dealershipId);
  if (!dealer.website) return "SKIPPED: no website on file";
  if (dealer.paused) return "SKIPPED: dealership is paused";
  const crawler = await Crawler.open({ maxPages: 4, present: (await getSettings()).researchPresentation });
  try {
    const home = await visitHome(crawler, { id: dealer.id, website: dealer.website });
    if (!home.snapshot) return `${home.page.outcome}: ${home.page.detail ?? "homepage could not be read"}`;
    const reads: { segment: "NEW" | "USED" | "ALL"; read: InventoryRead; url: string }[] = [];
    for (const target of pickInventoryPages(findLinks(home.snapshot).INVENTORY ?? [])) {
      const v = await crawler.visit(target.url, "INVENTORY");
      if (v.snapshot) reads.push({ segment: target.segment, read: readInventory(v.snapshot), url: v.snapshot.url });
    }
    if (reads.length === 0) return "OK: no inventory pages found";
    // Listing pages that show no prices often do on the vehicle page itself; look at up to three.
    if (reads.flatMap((r) => r.read.prices).length < 5) {
      const extra: number[] = [];
      for (const u of reads.flatMap((r) => r.read.vdpUrls).slice(0, 3)) {
        const v = await crawler.visit(u, "VDP");
        if (v.snapshot) extra.push(...extractPrices(v.snapshot));
      }
      if (extra.length) {
        reads[0]!.read.prices.push(...extra);
        reads[0]!.read.hidesPrices = false;
        await emit(`Asking prices read from ${Math.min(3, reads.flatMap((r) => r.read.vdpUrls).length)} vehicle page(s): the listing hides them`, { status: "DONE", kind: "finding.created" });
      }
    }
    const total = await persistInventory(dealershipId, reads);
    return `OK: inventory ${total ?? "not countable"}`;
  } finally {
    await crawler.close();
  }
}

/** Daily hiring check against the dealership's own careers page. External sources plug in via connectors (see signals worker). */
export async function runCareersScan(dealershipId: string): Promise<string> {
  const dealer = await loadTarget(dealershipId);
  if (!dealer.website) return "SKIPPED: no website on file";
  if (dealer.paused) return "SKIPPED: dealership is paused";
  const crawler = await Crawler.open({ maxPages: 3, present: (await getSettings()).researchPresentation });
  try {
    const home = await visitHome(crawler, { id: dealer.id, website: dealer.website });
    if (!home.snapshot) return `${home.page.outcome}: ${home.page.detail ?? "homepage could not be read"}`;
    const careersUrl = findLinks(home.snapshot).CAREERS?.[0];
    if (!careersUrl) return "OK: no careers page linked from the homepage";
    const careers = await crawler.visit(careersUrl, "CAREERS");
    if (!careers.snapshot) return `${careers.page.outcome}: careers page could not be read`;
    const found = extractHiringSignals(careers.snapshot);
    const n = await persistHiringSignals(dealershipId, dealer.groupId, found, careers.snapshot.url);
    await emit(n ? `Growth roles found: ${found.map((f) => f.title).join(", ")}` : "No growth or intake roles listed", { detail: careers.snapshot.url, status: n ? "DONE" : "INFO", kind: "finding.created" });
    return `OK: ${n} open positions matched`;
  } finally {
    await crawler.close();
  }
}

/**
 * Discovery: confirms the site is reachable and fills in blanks (phone, address, coordinates, brands,
 * parent group) from the schema.org data the dealership publishes about itself. Operator-entered
 * values are never overwritten.
 */
export async function runDiscovery(dealershipId: string): Promise<string> {
  const dealer = await loadTarget(dealershipId);
  if (!dealer.website) return "SKIPPED: no website on file";
  const crawler = await Crawler.open({ maxPages: 2, present: (await getSettings()).researchPresentation });
  try {
    const home = await visitHome(crawler, { id: dealer.id, website: dealer.website });
    if (!home.snapshot) return `${home.page.outcome}: ${home.page.detail ?? "homepage could not be read"}`;
    const info = extractDealerInfo(home.snapshot.jsonLd);
    await emit(info.name || info.phone || info.address ? "Read the dealership's published business details" : "The site publishes no structured business details", { detail: [info.name, info.phone, info.address, info.brands?.join("/")].filter(Boolean).join(" · ") || null, kind: "finding.created" });
    const patch: Partial<typeof dealerships.$inferInsert> = {};
    // A name typed in by an operator is kept; a placeholder made from the domain is replaced with
    // the name the site publishes (schema.org first, then the page title).
    if (isPlaceholderName(dealer.name, dealer.website)) {
      const fromTitle = (home.snapshot.title ?? "").split(/\s[|\-–—:]\s/)[0]?.replace(/^(home|welcome to)\s*/i, "").trim();
      const siteName = info.name ?? (fromTitle && fromTitle.length >= 3 && fromTitle.length <= 80 ? fromTitle : null);
      if (siteName && normalizeName(siteName) !== dealer.normalizedName) {
        patch.name = siteName;
        patch.normalizedName = normalizeName(siteName);
      }
    }
    if (!dealer.phone && info.phone && normalizePhone(info.phone)) {
      // Sites publish phone numbers in every format imaginable; store one consistent form.
      patch.normalizedPhone = normalizePhone(info.phone);
      patch.phone = formatPhone(patch.normalizedPhone) ?? info.phone;
    }
    if (!dealer.address && info.address) {
      patch.address = info.address;
      patch.normalizedAddress = normalizeAddress(info.address);
    }
    if (!dealer.city && info.city) patch.city = info.city;
    if (!dealer.state && info.state) patch.state = info.state.toUpperCase();
    if (!dealer.zip && info.zip) patch.zip = info.zip;
    if (dealer.latitude === null && info.latitude !== undefined && info.longitude !== undefined) {
      patch.latitude = info.latitude;
      patch.longitude = info.longitude;
    }
    if (dealer.brands.length === 0 && info.brands) patch.brands = info.brands;

    let groupNote = "";
    if (!dealer.groupId && info.parentOrganization) {
      const normalized = normalizeName(info.parentOrganization);
      if (normalized && normalized !== dealer.normalizedName) {
        const [group] = await db()
          .insert(dealerGroups)
          .values({ name: info.parentOrganization, normalizedName: normalized })
          .onConflictDoUpdate({ target: dealerGroups.normalizedName, set: { updatedAt: sql`now()` } })
          .returning({ id: dealerGroups.id });
        if (group) {
          patch.groupId = group.id;
          groupNote = `, linked to group "${info.parentOrganization}"`;
        }
      }
    }
    const fields = Object.keys(patch);
    if (fields.length) {
      await db().update(dealerships).set({ ...patch, updatedAt: new Date() }).where(eq(dealerships.id, dealershipId));
      await emit(`Filled in ${fields.filter((f) => !f.startsWith("normalized")).join(", ")}`, { status: "DONE" });
      await audit("system:discovery", "dealership.updated", "dealership", dealershipId, { fields, source: home.snapshot.url });
    }
    return `OK: ${fields.length ? `filled ${fields.join(", ")}` : "nothing new to fill in"}${groupNote}`;
  } finally {
    await crawler.close();
  }
}

export async function evidenceCount(dealershipId: string): Promise<number> {
  const rows = await db().select({ id: evidence.id }).from(evidence).where(eq(evidence.dealershipId, dealershipId));
  return rows.length;
}
