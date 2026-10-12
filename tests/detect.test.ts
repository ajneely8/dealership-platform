import { describe, expect, it } from "vitest";
import { planFields } from "@/workers/interaction/form-submit";
import {
  classifyForm,
  classifyForms,
  combineInventory,
  detectBlock,
  detectChat,
  detectService,
  detectTechnology,
  extractDealerInfo,
  extractHiringSignals,
  extractSocialLinks,
  findLinks,
  pickInventoryPages,
  readInventory,
} from "@/workers/website/detect";
import { isAllowed, parseRobots } from "@/workers/website/robots";
import type { PageSnapshot, RawField, RawForm } from "@/workers/website/snapshot";

const snap = (patch: Partial<PageSnapshot> = {}): PageSnapshot => ({
  url: "https://www.example-dealer.test/",
  title: "Example Dealer",
  httpStatus: 200,
  viewportMeta: true,
  scripts: [],
  iframes: [],
  inlineHints: [],
  links: [],
  forms: [],
  shortTexts: [],
  priceTexts: [],
  hidesPrices: false,
  text: "",
  jsonLd: [],
  generator: null,
  hasCaptcha: false,
  telLinks: [],
  smsLinks: [],
  ...patch,
});
const field = (name: string, type = "text", extra: Partial<RawField> = {}): RawField => ({ tag: "input", type, name, label: name, required: false, visible: true, ...extra });
const form = (context: string, fields: RawField[], extra: Partial<RawForm> = {}): RawForm => ({ action: "/lead", idClass: "", context, fields, hasCaptcha: false, ...extra });
const link = (href: string, text: string) => ({ href: new URL(href, "https://www.example-dealer.test").toString(), text });

describe("block detection", () => {
  it("recognises access controls and never treats a normal page as blocked", () => {
    expect(detectBlock(snap({ httpStatus: 403 }))).toBe("HTTP 403");
    expect(detectBlock(snap({ title: "Just a moment..." }))).toContain("Challenge");
    expect(detectBlock(snap({ text: "Please verify you are human", links: [] }))).toContain("human verification");
    expect(detectBlock(snap({ links: Array.from({ length: 20 }, (_, i) => link(`/p${i}`, "x")) }))).toBeNull();
  });
});

describe("chat and technology detection", () => {
  it("identifies known vendors from scripts, iframes and inline hints", () => {
    expect(detectChat([snap({ scripts: ["https://connect.podium.com/widget.js"] })])).toMatchObject({ present: true, vendor: "Podium", chatType: "LIVE" });
    expect(detectChat([snap(), snap({ inlineHints: ["impel.io"] })])).toMatchObject({ present: true, vendor: "Impel", chatType: "AI" });
    expect(detectChat([snap({ iframes: ["https://cdn.unknown-vendor.test/live-chat/frame.html"] })])).toMatchObject({ present: true, vendor: null, chatType: "UNKNOWN" });
    expect(detectChat([snap({ scripts: ["https://www.googletagmanager.com/gtm.js"] })]).present).toBe(false);
  });
  it("lists platform, scheduler and pixel technology once each", () => {
    const tech = detectTechnology([
      snap({ scripts: ["https://static.dealer.com/v9/app.js", "https://www.googletagmanager.com/gtm.js?id=X"], iframes: ["https://consumer.xtime.com/scheduling/"] }),
      snap({ scripts: ["https://static.dealer.com/v9/other.js"] }),
    ]);
    expect(tech.map((t) => t.name)).toEqual(["Google Tag Manager", "Xtime", "Dealer.com"]);
  });
});

describe("link discovery", () => {
  const home = snap({
    links: [
      link("/new-inventory/index.htm", "New Inventory"),
      link("/used-inventory/index.htm", "Pre-Owned Vehicles"),
      link("/new-inventory/2025-ford-f150-123.htm", "2025 Ford F-150"),
      link("/service/index.htm", "Service"),
      link("/service/schedule-service.htm", "Schedule Service"),
      link("/contact.htm", "Contact Us"),
      link("https://careers.hireology.com/exampledealer", "Careers"),
      link("https://other-site.test/contact", "Contact"),
      link("https://www.facebook.com/exampledealer/", ""),
      link("https://www.facebook.com/sharer/sharer.php?u=x", "Share"),
      link("https://www.instagram.com/", "Instagram"),
    ],
  });
  it("finds inventory, service, scheduler, contact and careers pages", () => {
    const links = findLinks(home);
    expect(pickInventoryPages(links.INVENTORY ?? []).map((p) => p.segment)).toEqual(["NEW", "USED"]);
    expect(links.INVENTORY?.join(" ")).not.toContain("f150");
    expect(links.SERVICE?.[0]).toContain("/service/index.htm");
    expect(links.SCHEDULER?.[0]).toContain("schedule-service");
    expect(links.CONTACT).toEqual(["https://www.example-dealer.test/contact.htm"]);
    expect(links.CAREERS?.[0]).toContain("hireology.com");
  });
  it("extracts real social profiles and ignores share buttons", () => {
    expect(extractSocialLinks([home])).toEqual([{ platform: "facebook", url: "https://www.facebook.com/exampledealer" }]);
  });
});

describe("form classification", () => {
  const contact = [field("firstName"), field("lastName"), field("email", "email"), field("phone", "tel"), field("comments", "textarea")];
  it("classifies lead forms", () => {
    expect(classifyForm(form("Contact Us | Send", contact), "CONTACT")).toBe("CONTACT");
    expect(classifyForm(form("Check Availability | Submit", contact), "VDP")).toBe("CHECK_AVAILABILITY");
    expect(classifyForm(form("| Submit", [...contact, field("vin", "hidden", { visible: false })]), "HOMEPAGE")).toBe("VEHICLE_INQUIRY");
    expect(classifyForm(form("Get E-Price | Submit", contact), "INVENTORY")).toBe("GET_INFORMATION");
    expect(classifyForm(form("Stay in touch | Go", contact), "HOMEPAGE")).toBe("GENERAL_LEAD");
    expect(classifyForm(form("Request a Service Appointment | Send", contact), "SERVICE")).toBe("SERVICE_REQUEST");
  });
  it("recognises the forms that must never be submitted", () => {
    expect(classifyForm(form("Get Pre-Approved | Apply", [...contact, field("ssn")]), "CONTACT")).toBe("FINANCE");
    expect(classifyForm(form("Value Your Trade | Next", contact), "HOMEPAGE")).toBe("TRADE_IN");
    expect(classifyForm(form("Schedule a Test Drive | Book", contact), "VDP")).toBe("TEST_DRIVE");
    expect(classifyForm(form("| Search", [field("q", "search")]), "HOMEPAGE")).toBe("SEARCH");
    expect(classifyForm(form("Newsletter | Subscribe", [field("email", "email")]), "HOMEPAGE")).toBe("NEWSLETTER");
  });
  it("flags prohibited fields and CAPTCHAs, and only reports visible fields", () => {
    const [f] = classifyForms(snap({ forms: [form("Contact Us", [...contact, field("tradeInVin"), field("honeypot", "text", { visible: false })], { hasCaptcha: true })] }), "CONTACT");
    expect(f).toMatchObject({ hasProhibitedFields: true, hasCaptcha: true });
    expect(f!.fields.map((x) => x.name)).not.toContain("honeypot");
  });
});

describe("form fill planning", () => {
  const identity = { name: "Dana Research", email: "research@example.test", phone: "2105550100" };
  const f = (name: string, type = "text", required = false, label = name) => ({ name, label, type, required });
  it("fills identity and message fields only", () => {
    const r = planFields([f("firstName"), f("lastName"), f("email", "email", true), f("phone", "tel"), f("comments", "textarea"), f("newsletter", "checkbox")], identity, "Is this vehicle still available?");
    expect(r).toEqual({
      plan: [
        { index: 0, action: "fill", value: "Dana" },
        { index: 1, action: "fill", value: "Research" },
        { index: 2, action: "fill", value: "research@example.test" },
        { index: 3, action: "fill", value: "2105550100" },
        { index: 4, action: "fill", value: "Is this vehicle still available?" },
      ],
    });
  });
  it("ticks a required consent box but refuses unknown required fields", () => {
    expect(planFields([f("email", "email"), f("agree", "checkbox", true, "I agree to the terms")], identity, "x")).toMatchObject({ plan: [{ index: 0 }, { index: 1, action: "check" }] });
    expect(planFields([f("email", "email"), f("budget", "text", true, "Monthly budget")], identity, "x")).toHaveProperty("error");
    expect(planFields([f("email", "email"), f("when", "date", true, "Preferred date")], identity, "x")).toHaveProperty("error");
    expect(planFields([f("comments", "textarea")], identity, "x")).toHaveProperty("error");
  });
});

describe("inventory reading", () => {
  it("reads a stated total and listing links", () => {
    const s = snap({
      url: "https://www.example-dealer.test/new-inventory/",
      shortTexts: ["427 Vehicles Found", "2025 Ford F-150"],
      links: [link("/new-inventory/2025-ford-f150-1.htm", "a"), link("/new-inventory/2025-ford-f150-2.htm", "b"), link("/new-inventory/2025-ford-f150-1.htm?x=1", "a")],
    });
    expect(readInventory(s)).toMatchObject({ count: 427, method: "PAGE_COUNT_TEXT" });
    expect(readInventory(s).vdpUrls).toHaveLength(2);
  });
  it("does not mistake a model year for a count, and falls back to a link count", () => {
    expect(readInventory(snap({ shortTexts: ["2025 vehicles", "Shop 2024 cars"] })).count).toBeNull();
    const links = Array.from({ length: 5 }, (_, i) => link(`/vehicle-details/used-2022-x-${i}`, "x"));
    expect(readInventory(snap({ links }))).toMatchObject({ count: 5, method: "VDP_LINK_COUNT" });
  });
  it("adds new and used and rates confidence by method", () => {
    const read = (count: number) => ({ count, method: "PAGE_COUNT_TEXT" as const, vdpUrls: [], prices: [], hidesPrices: false });
    expect(combineInventory([{ segment: "NEW", read: read(128) }, { segment: "USED", read: read(212) }])).toMatchObject({ total: 340, newCount: 128, usedCount: 212, confidence: "MEDIUM" });
    expect(combineInventory([{ segment: "ALL", read: { count: 12, method: "VDP_LINK_COUNT", vdpUrls: [], prices: [], hidesPrices: false } }])).toMatchObject({ total: 12, confidence: "LOW" });
  });
});

describe("service detection", () => {
  it("distinguishes embedded schedulers, form-only requests and phone-only", () => {
    const embedded = detectService({ servicePage: snap({ iframes: ["https://consumer.xtime.com/x"], text: "Text us to schedule", telLinks: ["1"] }), schedulerPage: null, schedulerLink: null, serviceForms: [], chatOnServicePage: true });
    expect(embedded).toMatchObject({ schedulerPresent: true, schedulerVendor: "Xtime", details: { schedulerMode: "EMBEDDED", smsOptionVisible: true, frictionNotes: [] } });

    const requestForm = classifyForms(snap({ forms: [form("Request a Service Appointment", Array.from({ length: 9 }, (_, i) => field(i === 0 ? "email" : `f${i}`)))] }), "SERVICE");
    const formOnly = detectService({ servicePage: snap({ telLinks: ["1"] }), schedulerPage: null, schedulerLink: null, serviceForms: requestForm, chatOnServicePage: false });
    expect(formOnly.details).toMatchObject({ schedulerMode: "FORM_ONLY", schedulerFieldCount: 9, phoneOnly: false, smsOptionVisible: false });

    const phoneOnly = detectService({ servicePage: snap({ telLinks: ["1"] }), schedulerPage: null, schedulerLink: null, serviceForms: [], chatOnServicePage: false });
    expect(phoneOnly).toMatchObject({ schedulerPresent: false, details: { schedulerMode: "NONE", phoneOnly: true } });
    expect(detectService({ servicePage: null, schedulerPage: null, schedulerLink: null, serviceForms: [], chatOnServicePage: false }).present).toBe(false);
  });
});

describe("hiring signals and dealer info", () => {
  it("reads intake and growth roles from a careers page and ignores shop-floor jobs", () => {
    const texts = ["BDC Representative", "Service Advisor", "Internet Sales Manager", "Social Media Coordinator", "Receptionist", "General Sales Manager", "Vice President of Sales", "Marketing Director", "Quick Lane Technician", "Automotive Technician", "Lot Porter", "Detailer", "Careers", "Schedule Service"];
    const found = extractHiringSignals(snap({ url: "https://www.example-dealer.test/careers", shortTexts: texts }));
    expect(found.map((s) => s.type)).toEqual(["BDC_HIRING", "SERVICE_HIRING", "INTERNET_SALES_HIRING", "SOCIAL_MEDIA_HIRING", "RECEPTIONIST_HIRING", "SALES_HIRING", "SALES_HIRING", "MARKETING_HIRING"]);
    expect(found.map((s) => s.title)).not.toContain("Quick Lane Technician");
    const promo = extractHiringSignals(snap({ url: "https://www.example-dealer.test/careers", shortTexts: ["GM Rewards", "Certified Pre-Owned Sales Event", "GM Financial", "General Manager"] }));
    expect(promo.map((s) => s.title)).toEqual(["General Manager"]);
    expect(extractHiringSignals(snap({ shortTexts: texts }))).toEqual([]);
  });
  it("reads schema.org dealer details", () => {
    const info = extractDealerInfo([{ "@graph": [{ "@type": "WebSite" }, { "@type": "AutoDealer", name: "Example Dealer", telephone: "210-555-0100", address: { streetAddress: "1 Main St", addressLocality: "Austin", addressRegion: "TX", postalCode: "78701" }, parentOrganization: { name: "Example Auto Group" } }] }]);
    expect(info).toMatchObject({ name: "Example Dealer", city: "Austin", state: "TX", parentOrganization: "Example Auto Group" });
    expect(extractDealerInfo([])).toEqual({});
  });
});

describe("robots.txt", () => {
  const txt = "User-agent: *\nDisallow: /admin\nDisallow: /search*sort=\nAllow: /admin/public\n\nUser-agent: DealerIntelResearch\nDisallow: /private\nCrawl-delay: 3";
  it("applies longest-match rules for the wildcard group", () => {
    const rules = parseRobots(txt, "SomeOtherBot");
    expect(isAllowed(rules, "/inventory")).toBe(true);
    expect(isAllowed(rules, "/admin/login")).toBe(false);
    expect(isAllowed(rules, "/admin/public/page")).toBe(true);
    expect(isAllowed(rules, "/search?x=1&sort=price")).toBe(false);
  });
  it("prefers our own user-agent group", () => {
    const rules = parseRobots(txt, "DealerIntelResearch");
    expect(rules.crawlDelaySeconds).toBe(3);
    expect(isAllowed(rules, "/private/x")).toBe(false);
    expect(isAllowed(rules, "/admin/login")).toBe(true);
  });
  it("allows everything when there are no rules", () => {
    expect(isAllowed(parseRobots("", "x"), "/anything")).toBe(true);
  });
});

describe("regressions found on real dealership sites", () => {
  it("a scheduling page we cannot identify is 'unrecognised', not 'no scheduler'", () => {
    const r = detectService({ servicePage: snap({ telLinks: ["1"] }), schedulerPage: snap({ url: "https://www.example-dealer.test/schedule-service" }), schedulerLink: null, serviceForms: [], chatOnServicePage: true });
    expect(r).toMatchObject({ schedulerPresent: true, schedulerVendor: null, details: { schedulerMode: "UNRECOGNISED", phoneOnly: false } });
  });
  it("job-description sentences are not treated as open positions", () => {
    const found = extractHiringSignals(snap({ url: "https://www.example-dealer.test/employment.html", shortTexts: ["Service Advisor", "Road tests vehicles when required or refers to the test technician."] }));
    expect(found.map((s) => s.title)).toEqual(["Service Advisor"]);
  });
  it("recognises listing links that end in a VIN after a hyphen", () => {
    const links = Array.from({ length: 4 }, (_, i) => link(`/new-New+Braunfels-2025-Chevrolet-Silverado-LT-1GCUDDED${i}SZ12345${i}`, "x"));
    expect(readInventory(snap({ links })).vdpUrls).toHaveLength(4);
  });
  it("a form on the scheduler page is a service request", () => {
    expect(classifyForm(form("| Submit", [field("name"), field("email", "email"), field("phone", "tel")]), "SCHEDULER")).toBe("SERVICE_REQUEST");
  });
});
