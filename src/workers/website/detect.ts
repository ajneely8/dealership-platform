import type { DetectedForm, ServiceDetails, VisitedPage } from "@/db/schema";
import type { Confidence, FormType, SignalType } from "@/domain/constants";
import { normalizeDomain } from "@/lib/normalize";
import type { PageSnapshot, RawForm } from "./snapshot";
import { CHAT_VENDORS, SCHEDULER_VENDORS, SOCIAL_HOSTS, TECHNOLOGY, type Signature } from "./vendors";

/** Pure detectors: PageSnapshot in, structured findings out. No browser, no network, no LLM. */

type PageKind = VisitedPage["kind"];

function haystack(s: PageSnapshot): string[] {
  return [...s.scripts, ...s.iframes, ...s.inlineHints].map((x) => x.toLowerCase());
}

function matchSignature<T extends Signature>(sigs: readonly T[], hay: readonly string[]): { sig: T; evidence: string }[] {
  const out: { sig: T; evidence: string }[] = [];
  for (const sig of sigs) {
    const hit = hay.find((h) => sig.needles.some((n) => h.includes(n)));
    if (hit) out.push({ sig, evidence: hit.slice(0, 160) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Blocking
// ---------------------------------------------------------------------------

const CHALLENGE_TITLES = /just a moment|attention required|access denied|are you a robot|verify you are human|pardon our interruption|security check|request blocked/i;

/** Recognises anti-bot walls so the scan records BLOCKED and moves on. Nothing here attempts to get past one. */
export function detectBlock(s: Pick<PageSnapshot, "httpStatus" | "title" | "text" | "links">): string | null {
  if (s.httpStatus === 401 || s.httpStatus === 403 || s.httpStatus === 429) return `HTTP ${s.httpStatus}`;
  if (s.title && CHALLENGE_TITLES.test(s.title)) return `Challenge page: "${s.title}"`;
  // A near-empty page that talks about verification is a challenge, not a dealership site.
  if (s.links.length < 5 && /captcha|verify (that )?you are (a )?human|unusual traffic|enable javascript and cookies/i.test(s.text)) {
    return "Challenge page (human verification)";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Chat & technology
// ---------------------------------------------------------------------------

export type ChatFinding = { present: boolean; vendor: string | null; chatType: string | null; evidence: string | null };

export function detectChat(snapshots: readonly PageSnapshot[]): ChatFinding {
  for (const s of snapshots) {
    const [hit] = matchSignature(CHAT_VENDORS, haystack(s));
    if (hit) return { present: true, vendor: hit.sig.name, chatType: hit.sig.chatType, evidence: hit.evidence };
  }
  // Generic fallback: an iframe or script that names itself as chat, from a vendor we don't recognise.
  for (const s of snapshots) {
    const generic = [...s.iframes, ...s.scripts].find((u) => /live-?chat|chat-?widget|webchat|chatbot/i.test(u));
    if (generic) return { present: true, vendor: null, chatType: "UNKNOWN", evidence: generic.slice(0, 160) };
  }
  return { present: false, vendor: null, chatType: null, evidence: null };
}

export function detectTechnology(snapshots: readonly PageSnapshot[]): { name: string; category: string; evidence: string }[] {
  const found = new Map<string, { name: string; category: string; evidence: string }>();
  for (const s of snapshots) {
    const hay = haystack(s);
    for (const { sig, evidence } of matchSignature([...TECHNOLOGY, ...CHAT_VENDORS, ...SCHEDULER_VENDORS], hay)) {
      if (!found.has(sig.name)) found.set(sig.name, { name: sig.name, category: sig.category, evidence });
    }
    if (s.generator && !found.has(s.generator)) {
      found.set(s.generator, { name: s.generator.slice(0, 60), category: "Website platform", evidence: "meta generator tag" });
    }
  }
  return [...found.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export function extractSocialLinks(snapshots: readonly PageSnapshot[]): { platform: string; url: string }[] {
  const out = new Map<string, { platform: string; url: string }>();
  for (const s of snapshots) {
    for (const l of s.links) {
      let u: URL;
      try {
        u = new URL(l.href);
      } catch {
        continue;
      }
      const host = u.hostname.replace(/^www\.|^m\./, "").toLowerCase();
      const social = SOCIAL_HOSTS.find((p) => p.hosts.includes(host));
      if (!social) continue;
      // Share buttons and bare platform homepages are not the dealership's profile.
      if (u.pathname === "/" || /sharer|share\.php|\/intent\/|\/share\b|\/hashtag\//i.test(u.pathname)) continue;
      const url = `${u.origin}${u.pathname.replace(/\/$/, "")}`;
      if (!out.has(social.platform)) out.set(social.platform, { platform: social.platform, url });
    }
  }
  return [...out.values()];
}

const LINK_PATTERNS: Record<Exclude<PageKind, "HOMEPAGE" | "VDP">, { href: RegExp; text: RegExp }> = {
  INVENTORY: { href: /inventory|searchnew|searchused|\/new-vehicles|\/used-vehicles|\/vehicles\b|\/cars-for-sale|\/new\/?$|\/used\/?$/i, text: /\b(new|used|pre-?owned|all)\s+(inventory|vehicles|cars)\b|\binventory\b/i },
  CONTACT: { href: /contact/i, text: /^contact( us)?$/i },
  SERVICE: { href: /\/service(\/|-center|-department|\.|$)|service-?and-?parts|\/auto-?service/i, text: /^(service|service center|service department|service & parts)$/i },
  SCHEDULER: { href: /schedule-?(a-)?service|service-?(appointment|scheduling|scheduler)|book-?service/i, text: /schedule (a |your )?service|service appointment|book (a |your )?service/i },
  CAREERS: { href: /career|employment|\/jobs|join-?(our-)?team|hireology/i, text: /^(careers?|employment|jobs|join our team|we'?re hiring|work with us)$/i },
  ABOUT: { href: /about/i, text: /^about( us)?$/i },
};

export const VDP_PATTERN = /\/vehicle-details\/|\/vdp\/|\/vehicle\/|inventory\/[^?#]*(19|20)\d{2}|\/(new|used|certified)\/[^?#]*(19|20)\d{2}|[\/-][A-HJ-NPR-Z0-9]{17}(\/|$|\?|\.)/i;

/**
 * Picks the best same-site link for each page type. Scheduler and careers links may point to a
 * vendor domain (Xtime, Hireology...); everything else must stay on the dealership's own domain.
 */
export function findLinks(home: PageSnapshot): Partial<Record<Exclude<PageKind, "HOMEPAGE" | "VDP">, string[]>> {
  const domain = normalizeDomain(home.url);
  const out: Partial<Record<Exclude<PageKind, "HOMEPAGE" | "VDP">, string[]>> = {};
  for (const kind of Object.keys(LINK_PATTERNS) as (keyof typeof LINK_PATTERNS)[]) {
    const { href, text } = LINK_PATTERNS[kind];
    const scored: { url: string; score: number }[] = [];
    for (const l of home.links) {
      const sameSite = normalizeDomain(l.href) === domain;
      const externalOk = kind === "SCHEDULER" || kind === "CAREERS";
      if (!sameSite && !externalOk) continue;
      let path: string;
      try {
        const u = new URL(l.href);
        path = u.pathname + u.search;
      } catch {
        continue;
      }
      const hrefHit = href.test(sameSite ? path : l.href);
      const textHit = text.test(l.text);
      if (!hrefHit && !textHit) continue;
      if (kind === "INVENTORY" && VDP_PATTERN.test(path)) continue;
      // A "sold" gallery is not inventory: it inflates the count and carries no asking prices.
      if (kind === "INVENTORY" && /\bsold\b|recently-sold|sold-inventory|sold-vehicles/i.test(`${path} ${l.text}`)) continue;
      // A service link that is really the scheduler belongs to SCHEDULER.
      if (kind === "SERVICE" && LINK_PATTERNS.SCHEDULER.href.test(path)) continue;
      scored.push({ url: l.href.split("#")[0]!, score: (hrefHit ? 2 : 0) + (textHit ? 3 : 0) - path.length / 200 });
    }
    const unique = [...new Map(scored.sort((a, b) => b.score - a.score).map((s) => [s.url, s])).keys()];
    if (unique.length) out[kind] = unique;
  }
  return out;
}

/** For inventory we want a "new" and a "used" listing page when the site separates them. */
export function pickInventoryPages(candidates: readonly string[]): { url: string; segment: "NEW" | "USED" | "ALL" }[] {
  const isNew = (u: string) => /new/i.test(u) && !/used|pre-?owned/i.test(u);
  const isUsed = (u: string) => /used|pre-?owned/i.test(u);
  const n = candidates.find(isNew);
  const u = candidates.find(isUsed);
  if (n && u) return [{ url: n, segment: "NEW" }, { url: u, segment: "USED" }];
  const first = candidates[0];
  if (!first) return [];
  return [{ url: first, segment: isNew(first) ? "NEW" : isUsed(first) ? "USED" : "ALL" }];
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

const PROHIBITED_FIELD = /ssn|social.?security|credit|income|employer|date.?of.?birth|\bdob\b|driver'?s?.?licen|trade|mileage|odometer|appointment|preferred.?(date|time)|test.?drive|down.?payment|monthly.?payment/i;

function formText(f: RawForm): string {
  return `${f.context} ${f.idClass} ${f.action ?? ""} ${f.fields.map((x) => `${x.name} ${x.label}`).join(" ")}`.toLowerCase();
}

export function classifyForm(f: RawForm, pageKind: PageKind): FormType {
  const visible = f.fields.filter((x) => x.visible);
  const text = formText(f);
  const has = (re: RegExp) => visible.some((x) => re.test(`${x.name} ${x.label} ${x.type}`));
  const hasEmail = has(/e-?mail/i);
  const hasPhone = has(/phone|tel\b|mobile|cell/i);
  const hasName = has(/name/i);

  if (visible.length === 0) return "OTHER";
  if (visible.some((x) => x.type === "search") || (visible.length <= 2 && /search|keyword|\bq\b/.test(text) && !hasEmail && !hasPhone)) return "SEARCH";
  if (/ssn|social.?security|credit app|finance app|pre-?qualif|pre-?approv|get approved|annual income|employer/.test(text)) return "FINANCE";
  if (/value (your|my) trade|trade-?in|appraisal|what'?s my car worth/.test(text)) return "TRADE_IN";
  if (/test.?drive/.test(text)) return "TEST_DRIVE";
  if (!hasEmail && !hasPhone) return "OTHER";
  if (visible.length <= 2 && hasEmail && /subscribe|newsletter|sign ?up|stay (in the loop|updated)/.test(text)) return "NEWSLETTER";
  // Any contact-style form on the scheduler page is a service request, whatever its heading says.
  if (pageKind === "SCHEDULER") return "SERVICE_REQUEST";
  if (/service|maintenance|repair/.test(text) && (pageKind === "SERVICE" || /appointment|schedule/.test(text))) return "SERVICE_REQUEST";
  if (/availab/.test(text)) return "CHECK_AVAILABILITY";
  if (pageKind === "VDP" || f.fields.some((x) => !x.visible && /vin|stock|vehicle/i.test(x.name))) return "VEHICLE_INQUIRY";
  if (/e-?price|more info|request info|get (a )?quote|get info|request (a )?quote|get (today'?s|our best) price/.test(text)) return "GET_INFORMATION";
  if (pageKind === "CONTACT" || /contact/.test(text)) return "CONTACT";
  return hasName ? "GENERAL_LEAD" : "OTHER";
}

export const LEAD_FORM_TYPES: readonly FormType[] = ["CONTACT", "VEHICLE_INQUIRY", "GET_INFORMATION", "CHECK_AVAILABILITY", "GENERAL_LEAD", "SERVICE_REQUEST"];

export function classifyForms(s: PageSnapshot, pageKind: PageKind): DetectedForm[] {
  return s.forms.map((f) => {
    const visible = f.fields.filter((x) => x.visible);
    return {
      type: classifyForm(f, pageKind),
      pageUrl: s.url,
      action: f.action,
      fields: visible.map((x) => ({ name: x.name, type: x.type, label: x.label, required: x.required })),
      hasProhibitedFields: visible.some((x) => PROHIBITED_FIELD.test(`${x.name} ${x.label}`)),
      hasCaptcha: f.hasCaptcha,
    };
  });
}

/** The same form template usually appears on many pages; count it once. */
export function dedupeForms(forms: readonly DetectedForm[]): DetectedForm[] {
  const seen = new Map<string, DetectedForm>();
  for (const f of forms) {
    const key = `${f.type}|${f.fields.map((x) => x.name || x.label).sort().join(",")}`;
    if (!seen.has(key)) seen.set(key, f);
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export type InventoryRead = { count: number | null; method: "PAGE_COUNT_TEXT" | "VDP_LINK_COUNT" | "NONE"; vdpUrls: string[]; prices: number[]; hidesPrices: boolean };

/**
 * Asking prices shown on an inventory page, in whole dollars. Monthly payments and down payments
 * fall under the floor; anything above the ceiling is not a vehicle price. Capped so one page of
 * 300 listings does not become a giant row.
 */
export function extractPrices(s: PageSnapshot): number[] {
  const out: number[] = [];
  const keep = (n: number) => {
    if (n >= 1500 && n <= 350_000) out.push(n);
  };
  // Read in the browser from the whole page: the reliable source.
  for (const t of s.priceTexts ?? []) {
    keep(Number(String(t).replace(/,/g, "")));
    if (out.length >= 300) return out;
  }
  if (out.length) return out;
  // Older snapshots (no priceTexts): the text slice.
  const re = /\$\s?(\d{1,3}(?:,\d{3})+|\d{4,6})(?!\d)(?!\s?\/\s?(?:mo|month|wk|week|bi-?weekly))/gi;
  for (const source of [...s.shortTexts, s.text]) {
    for (const m of source.matchAll(re)) {
      const n = Number(m[1]!.replace(/,/g, ""));
      if (n >= 1500 && n <= 350_000) out.push(n);
      if (out.length >= 300) return out;
    }
  }
  return out;
}

const COUNT_PATTERNS = [
  /\b(\d{1,3}(?:,\d{3})*|\d{1,5})\s+(?:new |used |pre-?owned |certified |matching |total )*(?:vehicles?|cars|trucks|suvs|results|matches)\b(?:\s+(?:found|available|in stock|match))?/gi,
  /\b(?:showing|of|found)\s+(\d{1,3}(?:,\d{3})*|\d{1,5})\s+(?:new |used |pre-?owned )?(?:vehicles?|cars|results)\b/gi,
];

export function readInventory(s: PageSnapshot): InventoryRead {
  const domain = normalizeDomain(s.url);
  const vdpUrls = [...new Set(s.links.filter((l) => normalizeDomain(l.href) === domain && VDP_PATTERN.test(l.href)).map((l) => l.href.split(/[?#]/)[0]!))];

  const counts: number[] = [];
  for (const source of [...s.shortTexts, s.text]) {
    for (const re of COUNT_PATTERNS) {
      re.lastIndex = 0;
      for (const m of source.matchAll(re)) {
        const n = Number(m[1]!.replace(/,/g, ""));
        // "2024 vehicles" style false positives: ignore numbers that look like model years.
        // No independent rooftop stocks thousands of vehicles: "10,000 vehicles sold" is marketing copy, not a lot.
        if (n >= 1 && n <= 2_500 && !(n >= 1990 && n <= 2035 && !/,/.test(m[1]!) && !/found|results|matches|showing|of /i.test(m[0]))) counts.push(n);
      }
    }
  }
  const prices = extractPrices(s);
  const hidesPrices = Boolean(s.hidesPrices) && prices.length < 5;
  if (counts.length) return { count: Math.max(...counts), method: "PAGE_COUNT_TEXT", vdpUrls, prices, hidesPrices };
  // Without a stated total, the number of distinct listing links on the first page is a floor, not a total.
  if (vdpUrls.length >= 3) return { count: vdpUrls.length, method: "VDP_LINK_COUNT", vdpUrls, prices, hidesPrices };
  return { count: null, method: "NONE", vdpUrls, prices, hidesPrices };
}

export function combineInventory(reads: readonly { segment: "NEW" | "USED" | "ALL"; read: InventoryRead }[]): {
  total: number | null;
  newCount: number | null;
  usedCount: number | null;
  method: InventoryRead["method"];
  confidence: Confidence;
  vdpUrls: string[];
  prices: number[];
  hidesPrices: boolean;
} {
  const get = (seg: "NEW" | "USED" | "ALL") => reads.find((r) => r.segment === seg)?.read ?? null;
  const n = get("NEW");
  const u = get("USED");
  const all = get("ALL");
  const vdpUrls = [...new Set(reads.flatMap((r) => r.read.vdpUrls))].slice(0, 400);
  const prices = reads.flatMap((r) => r.read.prices ?? []).slice(0, 300);
  const hidesPrices = prices.length < 5 && reads.some((r) => r.read.hidesPrices);
  const usable = reads.map((r) => r.read).filter((r) => r.count !== null);
  if (usable.length === 0) return { total: null, newCount: null, usedCount: null, method: "NONE", confidence: "LOW", vdpUrls, prices, hidesPrices };
  const method = usable.every((r) => r.method === "PAGE_COUNT_TEXT") ? "PAGE_COUNT_TEXT" : "VDP_LINK_COUNT";
  const total = all?.count ?? (n?.count ?? 0) + (u?.count ?? 0);
  return {
    total,
    newCount: n?.count ?? null,
    usedCount: u?.count ?? null,
    method,
    // A stated total on the page is a decent read; a link count only proves "at least this many".
    confidence: method === "PAGE_COUNT_TEXT" ? "MEDIUM" : "LOW",
    vdpUrls,
    prices,
    hidesPrices,
  };
}

export function detectInventoryAlerts(snapshots: readonly PageSnapshot[]): boolean {
  const re = /price (drop )?alerts?|notify me (when|if)|inventory alerts?|vehicle alerts?|save (this )?search|email me (when|new)|get alerts?|car ?finder|vehicle finder|alert me/i;
  return snapshots.some((s) => re.test(s.text) || s.shortTexts.some((t) => re.test(t)) || s.forms.some((f) => re.test(f.context)));
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function detectService(args: {
  servicePage: PageSnapshot | null;
  schedulerPage: PageSnapshot | null;
  schedulerLink: string | null;
  serviceForms: readonly DetectedForm[];
  chatOnServicePage: boolean;
}): { present: boolean; schedulerPresent: boolean; schedulerVendor: string | null; details: ServiceDetails | null } {
  const { servicePage, schedulerPage, schedulerLink } = args;
  if (!servicePage && !schedulerPage) return { present: false, schedulerPresent: false, schedulerVendor: null, details: null };
  const pages = [servicePage, schedulerPage].filter((p): p is PageSnapshot => p !== null);

  const embedded = pages.flatMap((p) => matchSignature(SCHEDULER_VENDORS, haystack(p)))[0];
  const linkHay = pages.flatMap((p) => p.links.map((l) => l.href.toLowerCase())).concat(schedulerLink ? [schedulerLink.toLowerCase()] : []);
  const linked = matchSignature(SCHEDULER_VENDORS, linkHay)[0];
  const requestForm = args.serviceForms.find((f) => f.type === "SERVICE_REQUEST");

  let mode: ServiceDetails["schedulerMode"] = "NONE";
  if (embedded) mode = "EMBEDDED";
  else if (linked) mode = "EXTERNAL_LINK";
  else if (requestForm) mode = "FORM_ONLY";
  // The site has a scheduling page but we could not tell what runs it. That is "unknown", not "no scheduler".
  else if (schedulerPage) mode = "UNRECOGNISED";

  const text = pages.map((p) => `${p.text} ${p.shortTexts.join(" ")}`).join(" ");
  const smsOptionVisible = pages.some((p) => p.smsLinks.length > 0) || /\btext (us|me|to schedule|our service)|\bsms\b|text-?to-?(schedule|service)/i.test(text);
  const specialsPresent = /service (specials?|coupons?|offers?)|maintenance specials?/i.test(text);
  const hasPhone = pages.some((p) => p.telLinks.length > 0);
  const phoneOnly = mode === "NONE" && hasPhone;

  const contactOptions: string[] = [];
  if (hasPhone) contactOptions.push("Phone");
  if (smsOptionVisible) contactOptions.push("SMS");
  if (args.chatOnServicePage) contactOptions.push("Chat");
  if (requestForm) contactOptions.push("Web form");
  if (embedded || linked || mode === "UNRECOGNISED") contactOptions.push("Online scheduler");

  const fieldCount = mode === "FORM_ONLY" && requestForm ? requestForm.fields.length : null;
  const frictionNotes: string[] = [];
  if (mode === "NONE") frictionNotes.push(phoneOnly ? "No online scheduler found; phone is the only way to book" : "No online scheduler found");
  if (mode === "UNRECOGNISED") frictionNotes.push("A scheduling page exists but its system was not recognised; check it by hand");
  if (mode === "FORM_ONLY") frictionNotes.push(`Service requests go through a ${fieldCount}-field web form, not a real-time scheduler`);
  if (!smsOptionVisible) frictionNotes.push("No text/SMS option visible on the service pages");
  if (!args.chatOnServicePage) frictionNotes.push("No chat on the service page");

  return {
    present: servicePage !== null || schedulerPage !== null,
    schedulerPresent: mode !== "NONE",
    schedulerVendor: (embedded ?? linked)?.sig.name ?? null,
    details: {
      servicePageUrl: servicePage?.url ?? null,
      schedulerUrl: schedulerPage?.url ?? schedulerLink,
      schedulerMode: mode,
      schedulerFieldCount: fieldCount,
      phoneOnly,
      smsOptionVisible,
      specialsPresent,
      chatOnServicePage: args.chatOnServicePage,
      contactOptions,
      frictionNotes,
    },
  };
}

// ---------------------------------------------------------------------------
// Hiring signals (from the dealership's own careers page)
// ---------------------------------------------------------------------------

/**
 * Only roles that mean the dealership is growing or adding people to handle customers.
 * Shop-floor roles (technicians, mechanics, porters, detailers, parts counter) are skipped on purpose:
 * they say nothing about lead handling, and they are the most common dealership job ad.
 */
const IGNORED_ROLE = /technician|\btech\b|mechanic|porter|detailer|lot attendant|car wash|body shop|painter|parts (counter|driver)|delivery driver|cashier|janitor|security/i;
// Navigation and promo items that contain a job-like word but are not openings ("GM Rewards", "Certified Pre-Owned").
const NOT_A_ROLE = /rewards|certified|protection|financ|special|offer|program|warranty|rebate|incentive|credit|lease|parts|accessor|tire|oil|inventory|vehicle|\bnew\b|\bused\b/i;
const JOB_PATTERNS: { type: SignalType; re: RegExp }[] = [
  { type: "BDC_HIRING", re: /\bbdc\b|business development (rep|representative|center|agent|manager|associate)|appointment (setter|coordinator)/i },
  { type: "RECEPTIONIST_HIRING", re: /receptionist|front desk|greeter|customer (service|experience|relations) (rep|representative|manager|specialist|coordinator)|guest (services|relations)/i },
  { type: "INTERNET_SALES_HIRING", re: /internet sales|e-?commerce (sales|manager)|digital sales|online sales/i },
  { type: "SOCIAL_MEDIA_HIRING", re: /social media|content creator/i },
  { type: "MARKETING_HIRING", re: /marketing/i },
  { type: "CRM_HIRING", re: /\bcrm\b/i },
  { type: "AI_HIRING", re: /\b(ai|artificial intelligence|automation) (specialist|manager|engineer|lead)/i },
  { type: "MANAGEMENT_CHANGE", re: /general manager|dealer principal|chief operating|\bcoo\b/i },
  { type: "SALES_HIRING", re: /(vice president|vp|director|general|finance|f&i|desk|floor|used car|new car|pre-?owned) (of )?sales( manager| director)?|sales (manager|director|consultant|associate|person|professional|advisor|representative|executive)|salesperson|product specialist|finance manager|f&i manager/i },
  { type: "SERVICE_HIRING", re: /service (advisor|writer|manager|director|consultant|coordinator|bdc)|fixed ops|fixed operations/i },
];
const NOT_A_POSTING = /^(careers?|jobs|employment|service|sales|parts|service (center|department|specials)|schedule service)$/i;

export type HiringSignal = { type: SignalType; title: string; confidence: Confidence };

export function extractHiringSignals(s: PageSnapshot): HiringSignal[] {
  const onCareersPage = /career|job|employment|hiring|join/i.test(`${s.url} ${s.title ?? ""}`);
  const out = new Map<string, HiringSignal>();
  for (const t of s.shortTexts) {
    // Job titles are short labels. Full sentences are lines from a job description, not openings.
    if (t.length > 70 || t.split(/\s+/).length > 8 || /[.!?:]$/.test(t) || NOT_A_POSTING.test(t)) continue;
    if (IGNORED_ROLE.test(t) || NOT_A_ROLE.test(t)) continue;
    const match = JOB_PATTERNS.find((p) => p.re.test(t));
    if (!match) continue;
    // Navigation items like "Service Advisor Reviews" are not openings; require a careers context.
    if (!onCareersPage) continue;
    const key = `${match.type}|${t.toLowerCase()}`;
    if (!out.has(key)) out.set(key, { type: match.type, title: t, confidence: "HIGH" });
  }
  return [...out.values()].slice(0, 40);
}

// ---------------------------------------------------------------------------
// Dealer identity from JSON-LD (used by discovery)
// ---------------------------------------------------------------------------

export type DealerInfo = { name?: string; phone?: string; address?: string; city?: string; state?: string; zip?: string; latitude?: number; longitude?: number; parentOrganization?: string; brands?: string[] };

export function extractDealerInfo(jsonLd: readonly unknown[]): DealerInfo {
  const nodes: Record<string, unknown>[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      nodes.push(o);
      if (o["@graph"]) walk(o["@graph"]);
    }
  };
  walk(jsonLd);
  const typeOf = (o: Record<string, unknown>) => (Array.isArray(o["@type"]) ? o["@type"].join(" ") : String(o["@type"] ?? ""));
  const node = nodes.find((o) => /AutoDealer|AutomotiveBusiness/i.test(typeOf(o))) ?? nodes.find((o) => /LocalBusiness|Organization/i.test(typeOf(o)));
  if (!node) return {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() && !Number.isNaN(Number(v)) ? Number(v) : undefined);
  const addr = (node.address && typeof node.address === "object" ? node.address : {}) as Record<string, unknown>;
  const geo = (node.geo && typeof node.geo === "object" ? node.geo : {}) as Record<string, unknown>;
  const parent = (node.parentOrganization && typeof node.parentOrganization === "object" ? node.parentOrganization : {}) as Record<string, unknown>;
  const brandRaw = Array.isArray(node.brand) ? node.brand : node.brand ? [node.brand] : [];
  const brands = brandRaw.map((b) => (typeof b === "string" ? b : str((b as Record<string, unknown>)?.name))).filter((b): b is string => !!b);
  return {
    name: str(node.name),
    phone: str(node.telephone),
    address: str(addr.streetAddress),
    city: str(addr.addressLocality),
    state: str(addr.addressRegion),
    zip: str(addr.postalCode),
    latitude: num(geo.latitude),
    longitude: num(geo.longitude),
    parentOrganization: str(parent.name),
    brands: brands.length ? brands : undefined,
  };
}
