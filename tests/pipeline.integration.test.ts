import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { RedisMemoryServer } from "redis-memory-server";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureSite } from "./fixtures/site-server";

/**
 * End-to-end loop against the LOCAL fixture site only (the crawler refuses any external host
 * when NODE_ENV=test): scan → score → brief → approve → submit → response → re-score → suppress.
 * Uses a real PostgreSQL, a real Redis and a real headless browser.
 */

const PG_PORT = 54377;
const REDIS_PORT = 63777;
const tmp = mkdtempSync(path.join(os.tmpdir(), "dealer-intel-test-"));

let pg: EmbeddedPostgres;
let redisServer: RedisMemoryServer;
let site: Awaited<ReturnType<typeof startFixtureSite>>;
let dealershipId: string;
let identityId: string;

// Modules are imported after the environment is set, because they read it at load/use time.
type Mods = {
  db: typeof import("@/db");
  schema: typeof import("@/db/schema");
  scan: typeof import("@/workers/website/scan");
  scoring: typeof import("@/domain/scoring/run");
  intel: typeof import("@/workers/sales-intel");
  form: typeof import("@/workers/interaction/form-submit");
  chat: typeof import("@/workers/interaction/chat-probe");
  eligibility: typeof import("@/domain/eligibility");
  responses: typeof import("@/domain/responses");
  check: typeof import("@/workers/response-check");
  suppression: typeof import("@/domain/suppression");
  settings: typeof import("@/lib/settings");
  queue: typeof import("@/queue");
  dedupe: typeof import("@/domain/dedupe");
};
let m: Mods;

beforeAll(async () => {
  pg = new EmbeddedPostgres({ databaseDir: path.join(tmp, "pg"), user: "postgres", password: "postgres", port: PG_PORT, persistent: false, onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("dealer_intel_test");
  redisServer = new RedisMemoryServer({ instance: { port: REDIS_PORT } });
  await redisServer.getPort();
  site = await startFixtureSite(0);

  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/dealer_intel_test`,
    REDIS_URL: `redis://127.0.0.1:${REDIS_PORT}`,
    SESSION_SECRET: "test-only-session-secret-0123456789abcdef",
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: path.join(tmp, "evidence"),
    ALLOW_LOCAL_TARGETS: "true",
    CRAWLER_PAGE_DELAY_MS: "0",
    AI_PROVIDER: "none",
  });

  m = {
    db: await import("@/db"),
    schema: await import("@/db/schema"),
    scan: await import("@/workers/website/scan"),
    scoring: await import("@/domain/scoring/run"),
    intel: await import("@/workers/sales-intel"),
    form: await import("@/workers/interaction/form-submit"),
    chat: await import("@/workers/interaction/chat-probe"),
    eligibility: await import("@/domain/eligibility"),
    responses: await import("@/domain/responses"),
    check: await import("@/workers/response-check"),
    suppression: await import("@/domain/suppression"),
    settings: await import("@/lib/settings"),
    queue: await import("@/queue"),
    dedupe: await import("@/domain/dedupe"),
  };
  await (await import("@/db/migrate")).runMigrations();

  const keys = m.dedupe.dedupeKeys({ name: "Fixture Motors", website: site.url });
  const [d] = await m.db
    .db()
    .insert(m.schema.dealerships)
    .values({ name: "Fixture Motors (LOCAL TEST SITE)", normalizedName: keys.normalizedName, website: site.url, normalizedDomain: keys.normalizedDomain })
    .returning({ id: m.schema.dealerships.id });
  dealershipId = d!.id;
  const [identity] = await m.db
    .db()
    .insert(m.schema.testIdentities)
    .values({ name: "Research Tester", email: "research@fixture.test", phone: "5555550199", normalizedPhone: "5555550199", createdBy: "test" })
    .returning({ id: m.schema.testIdentities.id });
  identityId = identity!.id;
});

afterAll(async () => {
  await m?.queue.closeQueues();
  await m?.db.closeDb();
  await site?.close();
  await redisServer?.stop();
  await pg?.stop();
  // Windows can hold PostgreSQL's files for a moment after shutdown; a leftover temp dir is harmless.
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    /* left for the OS temp cleaner */
  }
});

const db = () => m.db.db();
const latestObservation = async () => (await db().select().from(m.schema.websiteObservations).where(eq(m.schema.websiteObservations.dealershipId, dealershipId)).orderBy(desc(m.schema.websiteObservations.timestamp)).limit(1))[0]!;
const scoreMap = async () => Object.fromEntries((await db().select().from(m.schema.scores).where(eq(m.schema.scores.dealershipId, dealershipId))).map((s) => [s.product, s]));

async function requestTest(): Promise<string> {
  const obs = await latestObservation();
  const form = obs.leadForms.find((f) => f.type === "CONTACT")!;
  const [row] = await db()
    .insert(m.schema.testInteractions)
    .values({ dealershipId, identityId, testType: "FORM", formType: form.type, message: m.form.APPROVED_MESSAGES[3], sourceUrl: form.pageUrl, status: "APPROVED", requestedBy: "test", approvedBy: "test", approvedAt: new Date() })
    .returning({ id: m.schema.testInteractions.id });
  return row!.id;
}

describe("passive research", () => {
  it("scans the site and stores structured findings, screenshots, inventory and signals", async () => {
    const result = await m.scan.runWebsiteScan(dealershipId);
    expect(result).toMatch(/^OK/);

    const obs = await latestObservation();
    expect(obs).toMatchObject({
      websiteStatus: "OK",
      mobileFriendly: true,
      chatPresent: true,
      chatVendor: null, // generic widget: reported as unrecognised, never guessed
      inventoryPagePresent: true,
      inventoryCount: 340,
      inventoryAlertsPresent: false,
      servicePagePresent: true,
      serviceSchedulerPresent: true,
    });
    expect(obs.service).toMatchObject({ schedulerMode: "FORM_ONLY", schedulerFieldCount: 9, smsOptionVisible: false, chatOnServicePage: false });
    expect(obs.socialLinks.map((s) => s.platform).sort()).toEqual(["facebook", "instagram"]);
    const types = obs.leadForms.map((f) => f.type);
    expect(types).toEqual(expect.arrayContaining(["CONTACT", "CHECK_AVAILABILITY", "FINANCE", "SERVICE_REQUEST"]));
    expect(obs.leadForms.find((f) => f.type === "FINANCE")?.hasProhibitedFields).toBe(true);
    expect(obs.leadFormCount).toBe(3); // contact, availability, service — finance is not a lead form we count

    // robots.txt disallows /admin, and a passive scan never posts anything.
    expect(site.visits).not.toContain("/admin/login");
    expect(site.submissions).toHaveLength(0);

    const shots = await db().select().from(m.schema.evidence).where(eq(m.schema.evidence.dealershipId, dealershipId));
    expect(shots.map((s) => s.type)).toEqual(expect.arrayContaining(["HOMEPAGE", "INVENTORY", "FORM", "SERVICE"]));
    expect(shots.every((s) => s.bytes > 1000 && s.storageUrl.startsWith("local://"))).toBe(true);

    const [inv] = await db().select().from(m.schema.inventorySnapshots).where(eq(m.schema.inventorySnapshots.dealershipId, dealershipId));
    expect(inv).toMatchObject({ total: 340, newCount: 128, usedCount: 212, method: "PAGE_COUNT_TEXT" });
    expect(inv!.vdpUrls.length).toBe(24);

    const sig = await db().select().from(m.schema.signals).where(eq(m.schema.signals.dealershipId, dealershipId));
    expect(sig.map((s) => s.type).sort()).toEqual(["BDC_HIRING", "INTERNET_SALES_HIRING", "SERVICE_HIRING"]);
    expect(sig.every((s) => s.sourceUrl.endsWith("/careers"))).toBe(true);
  });

  it("scores deterministically with reasons that point at stored evidence", async () => {
    const first = await m.scoring.runScoring(dealershipId);
    const s = await scoreMap();
    expect(s.INVENTORY_OUTREACH!.reasons.map((r) => r.ruleId)).toEqual(["io.large_inventory", "io.no_alerts", "io.bdc_hiring", "io.internet_sales_hiring"]);
    expect(s.INVENTORY_OUTREACH!.score).toBe(70);
    expect(s.SERVICE_BOT!.reasons.map((r) => r.ruleId)).toEqual(["sv.poor_scheduler", "sv.no_service_chat", "sv.no_sms", "sv.service_hiring"]);
    expect(s.SERVICE_BOT!.score).toBe(65);
    expect(s.SUMMARYBOT!.score).toBe(15); // only the BDC hiring signal; nothing is claimed about lead follow-up before a test has run
    for (const row of Object.values(s)) for (const r of row.reasons) expect(r.evidence.length).toBeGreaterThan(0);

    expect(first).toMatchObject({ recommendedProduct: "INVENTORY_OUTREACH", changed: true });
    // Same evidence, same result, and no new history rows.
    const again = await m.scoring.runScoring(dealershipId);
    expect(again).toMatchObject({ priority: first!.priority, changed: false });
  });

  it("builds a sales brief whose every claim references evidence, without an AI provider", async () => {
    expect(await m.intel.runSalesIntel(dealershipId)).toMatch(/brief generated \(template angle/);
    const [brief] = await db().select().from(m.schema.salesBriefs).where(eq(m.schema.salesBriefs.dealershipId, dealershipId));
    expect(brief).toMatchObject({ recommendedProduct: "INVENTORY_OUTREACH", secondaryProduct: "SERVICE_BOT", angleSource: "TEMPLATE", model: null });
    expect(brief!.claims.length).toBeGreaterThan(4);
    for (const c of brief!.claims) expect(c.evidence.length, c.text).toBeGreaterThan(0);
    expect(brief!.recommendedRoles[0]).toBe("BDC Director");
    // Unchanged evidence does not produce a second brief.
    expect(await m.intel.runSalesIntel(dealershipId)).toMatch(/brief unchanged/);
  });
});

describe("controlled interaction", () => {
  it("skips while testing is disabled or the dealership is not approved", async () => {
    const id = await requestTest();
    expect(await m.form.runFormInteraction(id)).toMatch(/^SKIPPED: .*switched off.*not been approved/);
    expect(site.submissions).toHaveLength(0);
    const [row] = await db().select().from(m.schema.testInteractions).where(eq(m.schema.testInteractions.id, id));
    expect(row!.status).toBe("SKIPPED");
  });

  it("submits one approved inquiry, starts the timer, and stores screenshots and a transcript", async () => {
    await m.settings.updateSettings({ testingEnabled: true }, "test");
    await db().update(m.schema.dealerships).set({ testingApproved: true }).where(eq(m.schema.dealerships.id, dealershipId));

    const id = await requestTest();
    const before = Date.now();
    expect(await m.form.runFormInteraction(id)).toMatch(/^SUBMITTED/);

    expect(site.submissions).toHaveLength(1);
    expect(site.submissions[0]).toMatchObject({
      path: "/lead",
      fields: { firstName: "Research", lastName: "Tester", email: "research@fixture.test", phone: "5555550199", comments: "Can someone send me more information about your current inventory?" },
    });
    expect(site.submissions[0]!.fields.newsletter).toBeUndefined(); // optional marketing opt-in left unticked

    const [row] = await db().select().from(m.schema.testInteractions).where(eq(m.schema.testInteractions.id, id));
    expect(row!.status).toBe("MONITORING");
    expect(row!.submittedAt!.getTime()).toBeGreaterThanOrEqual(before);
    const transcript = await db().select().from(m.schema.transcriptMessages).where(eq(m.schema.transcriptMessages.interactionId, id));
    expect(transcript.map((t) => t.speaker)).toEqual(["RESEARCHER", "SYSTEM"]);
    expect(transcript[1]!.message).toContain("Thank you");
    const shots = await db().select().from(m.schema.evidence).where(eq(m.schema.evidence.interactionId, id));
    expect(shots).toHaveLength(2);

    // Running the same job again must not submit twice.
    expect(await m.form.runFormInteraction(id)).toMatch(/not in APPROVED state/);
    expect(site.submissions).toHaveLength(1);
  });

  it("refuses a second test: active test and cooldown", async () => {
    const result = await m.eligibility.checkEligibility({ dealershipId, identityId, targetUrl: `${site.url}/contact`, formType: "CONTACT", form: null });
    expect(result.reasons.map((r) => r.code)).toEqual(["COOLDOWN", "ACTIVE_TEST"]);
    const id = await requestTest();
    expect(await m.form.runFormInteraction(id)).toMatch(/^SKIPPED/);
    expect(site.submissions).toHaveLength(1);
  });

  it("never submits a finance form, even if one is requested directly", async () => {
    const [row] = await db()
      .insert(m.schema.testInteractions)
      .values({ dealershipId, identityId, testType: "FORM", formType: "FINANCE", message: m.form.APPROVED_MESSAGES[0], sourceUrl: `${site.url}/contact`, status: "APPROVED", requestedBy: "test" })
      .returning({ id: m.schema.testInteractions.id });
    expect(await m.form.runFormInteraction(row!.id)).toMatch(/^SKIPPED: .*never submitted/);
    expect(site.submissions.filter((s) => s.path === "/finance")).toHaveLength(0);
  });
});

describe("automated chat test", () => {
  it("opens the widget, passes the contact gate, asks the question, follows up once from the approved list and records the replies", async () => {
    // Its own cooldown: the form test from above does not block a chat test.
    const [row] = await db()
      .insert(m.schema.testInteractions)
      .values({ dealershipId, identityId, testType: "CHAT", message: m.form.APPROVED_MESSAGES[0], sourceUrl: site.url, status: "APPROVED", requestedBy: "test", approvedBy: "test", approvedAt: new Date() })
      .returning({ id: m.schema.testInteractions.id });
    const id = row!.id;
    expect(await m.chat.runChatProbe(id)).toMatch(/^COMPLETED: 2 reply/);

    const [i] = await db().select().from(m.schema.testInteractions).where(eq(m.schema.testInteractions.id, id));
    expect(i).toMatchObject({ status: "COMPLETED", testType: "CHAT" });
    expect(i!.submittedAt).not.toBeNull();
    expect(i!.firstResponseSeconds).toBeLessThanOrEqual(10);

    const replies = await db().select().from(m.schema.responses).where(eq(m.schema.responses.interactionId, id)).orderBy(m.schema.responses.receivedAt);
    expect(replies.map((r) => r.message)).toEqual(["Fixture Bot: Yes, that vehicle is still available at our Testville store.", "Fixture Bot: A product specialist will text you shortly with more details."]);
    expect(replies.every((r) => r.channel === "CHAT" && r.ingestedVia === "PROBE")).toBe(true);

    const transcript = await db().select().from(m.schema.transcriptMessages).where(eq(m.schema.transcriptMessages.interactionId, id)).orderBy(m.schema.transcriptMessages.timestamp);
    expect(transcript.map((t) => t.speaker)).toEqual(["SYSTEM", "RESEARCHER", "DEALERSHIP", "DEALERSHIP", "RESEARCHER"]);
    // The latest bot line was "a specialist will text you", so the one follow-up is the approved general inventory question.
    expect(transcript[4]!.message).toBe("Can someone send me more information about your current inventory?");
    expect(transcript[0]!.message).toContain("contact details before starting");
    // The identity's details, and nothing else, went into the gate; the fixture logs only form POSTs, so none was added.
    expect(site.submissions).toHaveLength(1);

    const obs = await latestObservation();
    expect(obs).toMatchObject({ chatWorking: true, contactRequired: true });
    const shots = await db().select().from(m.schema.evidence).where(eq(m.schema.evidence.interactionId, id));
    expect(shots.filter((s) => s.type === "CHAT")).toHaveLength(3);

    // Running it again must not send a second question.
    expect(await m.chat.runChatProbe(id)).toMatch(/not in APPROVED state/);
  }, 240_000);
});

describe("responses and re-scoring", () => {
  const monitored = async () => (await db().select().from(m.schema.testInteractions).where(eq(m.schema.testInteractions.status, "MONITORING")))[0]!;

  it("matches an inbound email to the open test, times it and classifies it", async () => {
    const i = await monitored();
    const receivedAt = new Date(i.submittedAt!.getTime() + 18 * 60_000);
    const result = await m.responses.ingestInbound({ channel: "EMAIL", receivedAt, sender: "noreply@fixture.test", recipient: "Research Tester <research@fixture.test>", message: "Thank you for contacting Fixture Motors. A member of our team will be in touch.", externalId: "email:abc" });
    expect(result).toEqual({ matched: true, interactionId: i.id });

    const [r] = await db().select().from(m.schema.responses).where(eq(m.schema.responses.interactionId, i.id));
    expect(r).toMatchObject({ channel: "EMAIL", responseSeconds: 1080, classification: "AUTOMATED_FOLLOW_UP", humanOrAutomation: "AUTOMATION", classifiedBy: "RULE", ingestedVia: "WEBHOOK" });
    const [after] = await db().select().from(m.schema.testInteractions).where(eq(m.schema.testInteractions.id, i.id));
    expect(after!.firstResponseSeconds).toBe(1080);

    // Provider redelivery is idempotent.
    await m.responses.ingestInbound({ channel: "EMAIL", receivedAt, sender: "noreply@fixture.test", recipient: "research@fixture.test", message: "dup", externalId: "email:abc" });
    expect(await db().select().from(m.schema.responses).where(eq(m.schema.responses.interactionId, i.id))).toHaveLength(1);
  });

  it("parks messages it cannot attribute instead of guessing", async () => {
    const result = await m.responses.ingestInbound({ channel: "SMS", receivedAt: new Date(), sender: "+15555550100", recipient: "+15555559999", message: "hello", externalId: null });
    expect(result).toMatchObject({ matched: false });
    expect(await db().select().from(m.schema.unmatchedInbound)).toHaveLength(1);
  });

  it("raises the SummaryBot score once the evidence supports it", async () => {
    const i = await monitored();
    // Move the submission 3 hours into the past so the 1-hour rules can be judged.
    const submittedAt = new Date(Date.now() - 3 * 3_600_000);
    await db().update(m.schema.testInteractions).set({ submittedAt }).where(eq(m.schema.testInteractions.id, i.id));
    expect(await m.check.runResponseCheck(i.id)).toMatch(/^OK/);
    const [checked] = await db().select().from(m.schema.testInteractions).where(eq(m.schema.testInteractions.id, i.id));
    expect(checked!.milestones).toMatchObject({ "5m": false, "15m": false, "1h": true });

    await m.scoring.runScoring(dealershipId);
    const s = await scoreMap();
    expect(s.SUMMARYBOT!.reasons.map((r) => r.ruleId)).toEqual(["sb.no_sms", "sb.slow_response", "sb.generic_email", "sb.growth_hiring"]);
    expect(s.SUMMARYBOT!.score).toBe(70);
    const history = await db().select().from(m.schema.scoreHistory).where(eq(m.schema.scoreHistory.dealershipId, dealershipId));
    expect(history.some((h) => h.subject === "SUMMARYBOT" && h.score === 70)).toBe(true);
  });
});

describe("suppression", () => {
  it("group suppression covers the rooftop and blocks testing; lifting it restores eligibility checks", async () => {
    const [group] = await db().insert(m.schema.dealerGroups).values({ name: "Fixture Auto Group", normalizedName: "fixture auto group" }).returning({ id: m.schema.dealerGroups.id });
    await db().update(m.schema.dealerships).set({ groupId: group!.id }).where(eq(m.schema.dealerships.id, dealershipId));
    const id = await m.suppression.createSuppression({ scope: "GROUP", groupId: group!.id, reason: "CUSTOMER" }, "test");

    const [d] = await db().select().from(m.schema.dealerships).where(eq(m.schema.dealerships.id, dealershipId));
    expect(d).toMatchObject({ suppressed: true, suppressionReason: "CUSTOMER" });
    const blocked = await m.eligibility.checkEligibility({ dealershipId, identityId, targetUrl: `${site.url}/contact`, formType: "CONTACT", form: null });
    expect(blocked.reasons.map((r) => r.code)).toContain("SUPPRESSED");

    await m.suppression.liftSuppression(id, "test");
    const [after] = await db().select().from(m.schema.dealerships).where(eq(m.schema.dealerships.id, dealershipId));
    expect(after!.suppressed).toBe(false);

    const audit = await db().select().from(m.schema.auditLogs);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["suppression.created", "suppression.lifted", "test.submitted", "test.skipped", "score.changed", "response.recorded"]));
  });
});
