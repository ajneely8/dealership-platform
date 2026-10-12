"use server";

import { parse as parseCsv } from "csv-parse/sync";
import { salesTouches } from "@/db/schema";
import { SALES_OUTCOMES, SALES_OUTCOME_LABEL, SALES_OUTCOME_STAGE } from "@/domain/constants";
import { and, desc, eq, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import {
  contacts,
  dealerGroups,
  dealerships,
  jobRuns,
  notes,
  signals,
  socialObservations,
  testIdentities,
  testInteractions,
  transcriptMessages,
  unmatchedInbound,
  users,
  websiteObservations,
} from "@/db/schema";
import { CHANNELS, CONFIDENCE, PIPELINE_STAGES, QUEUES, RECEPTIONIST_STATUSES, ROLES, SIGNAL_TYPES, SUPPRESSION_REASONS, SUPPRESSION_SCOPES, type QueueName } from "@/domain/constants";
import { dedupeKeys, findDuplicateInDb } from "@/domain/dedupe";
import { checkEligibility } from "@/domain/eligibility";
import { refreshGroupIntel } from "@/domain/group-intel";
import { recordResponse, redactSecrets } from "@/domain/responses";
import { RULES } from "@/domain/scoring/config";
import { createSuppression, liftSuppression, syncSuppressionFlags } from "@/domain/suppression";
import { env } from "@/env";
import { act, opt, str } from "@/lib/action";
import { audit } from "@/lib/audit";
import { saveScreenshot } from "@/lib/evidence";
import { emit } from "@/lib/agent-events";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSession, destroySession, requireRole } from "@/lib/auth/session";
import { nameFromDomain, normalizeName, normalizePhone, normalizeWebsite } from "@/lib/normalize";
import { getSettings, settingsSchema, updateSettings } from "@/lib/settings";
import { enqueue, getQueue, redis, type JobPayloads, NO_QUEUE_REASON } from "@/queue";
import { APPROVED_MESSAGES } from "@/domain/constants";
import { createHash } from "node:crypto";

const uuid = z.string().uuid();
const httpUrl = z.string().url().refine((u) => /^https?:\/\//i.test(u), "must start with http:// or https://");

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function login(form: FormData) {
  await act(form, "/login", async () => {
    const email = str(form, "email").toLowerCase();
    const password = str(form, "password");
    if (!email || !password) throw new Error("Enter your email and password.");

    // Rate limit: 8 attempts per 15 minutes per account.
    const key = `login:${createHash("sha256").update(email).digest("hex").slice(0, 24)}`;
    const attempts = await redis().incr(key);
    if (attempts === 1) await redis().expire(key, 15 * 60);
    if (attempts > 8) throw new Error("Too many sign-in attempts. Try again in 15 minutes.");

    const [user] = await db().select().from(users).where(eq(users.email, email)).limit(1);
    // Same message for unknown account and wrong password.
    if (!user || !user.active || !verifyPassword(password, user.passwordHash)) throw new Error("Email or password is incorrect.");
    await redis().del(key);
    await createSession(user.id);
    await audit(user.email, "user.login", "user", user.id);
    return "redirect:/command";
  });
}

export async function logout() {
  await destroySession();
  redirect("/login");
}

// ---------------------------------------------------------------------------
// Dealerships
// ---------------------------------------------------------------------------

const dealershipInput = z
  .object({
    name: z.string().max(200),
    website: z.string().max(300).nullable(),
  phone: z.string().max(40).nullable(),
  address: z.string().max(300).nullable(),
  city: z.string().max(120).nullable(),
  state: z.string().max(40).nullable(),
  zip: z.string().max(12).nullable(),
    brands: z.array(z.string().max(60)).max(30),
    groupId: uuid.nullable(),
  })
  // Either a name or a website is enough; a missing name is filled from the website.
  .transform((d) => ({ ...d, name: d.name.trim() || nameFromDomain(d.website) || "" }))
  .refine((d) => d.name.length >= 2, { message: "Enter a website address or a dealership name.", path: ["name"] });

function readDealership(form: FormData) {
  return dealershipInput.parse({
    name: str(form, "name"),
    website: opt(form, "website"),
    phone: opt(form, "phone"),
    address: opt(form, "address"),
    city: opt(form, "city"),
    state: opt(form, "state"),
    zip: opt(form, "zip"),
    brands: str(form, "brands").split(",").map((b) => b.trim()).filter(Boolean),
    groupId: opt(form, "groupId"),
  });
}

function dealershipValues(input: z.infer<typeof dealershipInput>) {
  const website = input.website ? normalizeWebsite(input.website) : null;
  if (input.website && !website) throw new Error(`"${input.website}" is not a valid website address.`);
  const keys = dedupeKeys({ ...input, website });
  return {
    name: input.name,
    normalizedName: keys.normalizedName,
    website,
    normalizedDomain: keys.normalizedDomain,
    phone: input.phone,
    normalizedPhone: keys.normalizedPhone,
    address: input.address,
    normalizedAddress: keys.normalizedAddress,
    city: input.city,
    state: keys.state,
    zip: input.zip,
    brands: input.brands,
    groupId: input.groupId,
  };
}

export async function createDealership(form: FormData) {
  await act(form, "/dealerships", async () => {
    const user = await requireRole("OPERATOR");
    const input = readDealership(form);
    const values = dealershipValues(input);
    const dupe = await findDuplicateInDb({ ...input, website: values.website });
    if (dupe) throw new Error(`Already on file as "${dupe.name}" (matched on ${dupe.reason.toLowerCase().replace("_", " + ")}).`);
    const [row] = await db().insert(dealerships).values(values).returning({ id: dealerships.id });
    if (!row) throw new Error("Could not create the dealership.");
    await syncSuppressionFlags();
    await audit(user.email, "dealership.created", "dealership", row.id, { name: input.name });
    if (values.website) await enqueue("discovery", { dealershipId: row.id });
    if (values.groupId) await refreshGroupIntel(values.groupId);
    return `redirect:/dealerships/${row.id}?notice=${encodeURIComponent(values.website ? "Dealership added. Website research is queued." : "Dealership added. Add a website to start research.")}`;
  });
}

export async function updateDealership(form: FormData) {
  await act(form, "/dealerships", async () => {
    const user = await requireRole("OPERATOR");
    const id = uuid.parse(str(form, "id"));
    const input = readDealership(form);
    const values = dealershipValues(input);
    const dupe = await findDuplicateInDb({ ...input, website: values.website }, id);
    if (dupe) throw new Error(`These details match "${dupe.name}" (${dupe.reason.toLowerCase().replace("_", " + ")}). Merge or correct instead of duplicating.`);
    const [before] = await db().select({ groupId: dealerships.groupId }).from(dealerships).where(eq(dealerships.id, id)).limit(1);
    await db().update(dealerships).set({ ...values, updatedAt: new Date() }).where(eq(dealerships.id, id));
    await syncSuppressionFlags();
    for (const g of new Set([before?.groupId, values.groupId])) if (g) await refreshGroupIntel(g);
    await audit(user.email, "dealership.updated", "dealership", id, { fields: Object.keys(values) });
    return "Dealership updated.";
  });
}

export async function deleteDealership(form: FormData) {
  await act(form, "/dealerships", async () => {
    const user = await requireRole("ADMIN");
    const id = uuid.parse(str(form, "id"));
    const [d] = await db().delete(dealerships).where(eq(dealerships.id, id)).returning({ name: dealerships.name, groupId: dealerships.groupId });
    if (!d) throw new Error("Dealership not found.");
    if (d.groupId) await refreshGroupIntel(d.groupId);
    await audit(user.email, "dealership.deleted", "dealership", id, { name: d.name });
    return `redirect:/dealerships?notice=${encodeURIComponent(`Deleted ${d.name}.`)}`;
  });
}

async function findOrCreateGroup(name: string, actor: string): Promise<string> {
  const normalizedName = normalizeName(name);
  if (!normalizedName) throw new Error("Group name is empty.");
  const [existing] = await db().select({ id: dealerGroups.id }).from(dealerGroups).where(eq(dealerGroups.normalizedName, normalizedName)).limit(1);
  if (existing) return existing.id;
  const [row] = await db().insert(dealerGroups).values({ name: name.trim(), normalizedName }).returning({ id: dealerGroups.id });
  if (!row) throw new Error("Could not create group.");
  await audit(actor, "group.created", "group", row.id, { name, via: "import" });
  return row.id;
}

const CSV_HEADERS = ["name", "website", "phone", "address", "city", "state", "zip", "brands", "group"] as const;

export async function importDealerships(form: FormData) {
  await act(form, "/dealerships", async () => {
    const user = await requireRole("OPERATOR");
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) throw new Error("Choose a CSV file to import.");
    if (file.size > 4_000_000) throw new Error("CSV is larger than 4 MB. Split it into smaller files.");

    let rows: Record<string, string>[];
    try {
      rows = parseCsv(await file.text(), { columns: (h: string[]) => h.map((c) => c.trim().toLowerCase()), skip_empty_lines: true, trim: true, bom: true, relax_column_count: true });
    } catch (err) {
      throw new Error(`Could not read the CSV: ${(err as Error).message}`);
    }
    if (rows.length === 0) throw new Error("The CSV has no data rows.");
    if (!("name" in rows[0]!) && !("website" in rows[0]!)) throw new Error(`The CSV needs a "name" or "website" column. Supported columns: ${CSV_HEADERS.join(", ")}.`);
    if (rows.length > 5000) throw new Error("Import at most 5,000 rows at a time.");

    let created = 0;
    const skipped: string[] = [];
    const groups = new Set<string>();
    for (const [i, r] of rows.entries()) {
      const line = i + 2;
      const parsed = dealershipInput.safeParse({
        name: r.name ?? "",
        website: r.website || null,
        phone: r.phone || null,
        address: r.address || null,
        city: r.city || null,
        state: r.state || null,
        zip: r.zip || null,
        brands: (r.brands ?? "").split(/[;|,]/).map((b) => b.trim()).filter(Boolean),
        groupId: null,
      });
      if (!parsed.success) {
        skipped.push(`row ${line}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
        continue;
      }
      try {
        const groupId = r.group ? await findOrCreateGroup(r.group, user.email) : null;
        const values = dealershipValues({ ...parsed.data, groupId });
        // Checked against the database each time, so duplicates inside the same file are caught too.
        const dupe = await findDuplicateInDb({ ...parsed.data, website: values.website, groupId });
        if (dupe) {
          skipped.push(`row ${line}: duplicate of "${dupe.name}" (${dupe.reason.toLowerCase()})`);
          continue;
        }
        const [row] = await db().insert(dealerships).values(values).returning({ id: dealerships.id });
        if (!row) continue;
        created += 1;
        if (groupId) groups.add(groupId);
        if (values.website) await enqueue("discovery", { dealershipId: row.id });
      } catch (err) {
        skipped.push(`row ${line}: ${(err as Error).message}`);
      }
    }
    await syncSuppressionFlags();
    for (const g of groups) await refreshGroupIntel(g);
    await audit(user.email, "dealership.imported", "dealership", null, { file: file.name, rows: rows.length, created, skipped: skipped.length, details: skipped.slice(0, 50) });
    const detail = skipped.length ? ` Skipped ${skipped.length}: ${skipped.slice(0, 4).join("; ")}${skipped.length > 4 ? "… (full list in the audit log)" : ""}` : "";
    return `Imported ${created} of ${rows.length} rows.${detail}`;
  });
}

const MANUAL_QUEUES = ["discovery", "website-scan", "inventory", "signals", "social", "scoring", "sales-intel"] as const;
const QUEUE_NOTICE: Record<(typeof MANUAL_QUEUES)[number], string> = {
  discovery: "Reading the website now.",
  "website-scan": "Scanning the website now. Results appear here in about a minute.",
  inventory: "Counting inventory now.",
  signals: "Checking the careers page now.",
  social: "Checking social profiles now.",
  scoring: "Re-scoring now.",
  "sales-intel": "Rebuilding the brief now.",
};

export async function queueJob(form: FormData) {
  await act(form, "/dealerships", async () => {
    const user = await requireRole("OPERATOR");
    const dealershipId = uuid.parse(str(form, "dealershipId"));
    const queue = z.enum(MANUAL_QUEUES).parse(str(form, "queue"));
    const result = await enqueue(queue, { dealershipId, manual: true });
    await audit(user.email, "job.enqueued", "dealership", dealershipId, { queue, queued: result.queued });
    if (result.queued) await emit(`${queue} requested by ${user.email}`, { agent: "orion", dealershipId, status: "INFO", kind: "task.created" });
    return result.queued ? QUEUE_NOTICE[queue] : (result.reason === NO_QUEUE_REASON ? NO_QUEUE_REASON : "That is already running for this dealership.");
  });
}

export async function setPaused(form: FormData) {
  await act(form, "/dealerships", async () => {
    const user = await requireRole("OPERATOR");
    const id = uuid.parse(str(form, "id"));
    const paused = str(form, "paused") === "true";
    await db().update(dealerships).set({ paused, updatedAt: new Date() }).where(eq(dealerships.id, id));
    await audit(user.email, "dealership.paused", "dealership", id, { paused });
    return paused ? "Dealership paused. Scheduled research and testing will skip it." : "Dealership resumed.";
  });
}

export async function setTestingApproval(form: FormData) {
  await act(form, "/dealerships", async () => {
    const user = await requireRole("OPERATOR");
    const id = uuid.parse(str(form, "id"));
    const approved = str(form, "approved") === "true";
    await db()
      .update(dealerships)
      .set({ testingApproved: approved, testingApprovedBy: approved ? user.email : null, testingApprovedAt: approved ? new Date() : null, updatedAt: new Date() })
      .where(eq(dealerships.id, id));
    await audit(user.email, "dealership.testing_approval", "dealership", id, { approved });
    return approved ? "Approved for controlled testing." : "Testing disabled for this dealership.";
  });
}

/** Records a chatbot answer an operator found by visiting the site themselves, for sites the scanner cannot read. */
export async function setManualChatbot(form: FormData) {
  await act(form, "/dealerships", async () => {
    const user = await requireRole("OPERATOR");
    const id = uuid.parse(str(form, "id"));
    const value = str(form, "manualChatbot");
    const manualChatbot = value === "" ? null : z.enum(["YES", "NO"]).parse(value);
    const note = z.string().max(300).nullable().parse(opt(form, "note"));
    await db()
      .update(dealerships)
      .set({ manualChatbot, manualChatbotNote: manualChatbot ? note : null, manualChatbotBy: manualChatbot ? user.email : null, updatedAt: new Date() })
      .where(eq(dealerships.id, id));
    await audit(user.email, "dealership.updated", "dealership", id, { fields: ["manualChatbot"], manualChatbot });
    return manualChatbot ? "Chatbot check recorded." : "Chatbot check cleared.";
  });
}

/** Records what answered when an operator phoned the dealership. The only way the receptionist question gets answered. */
export async function setReceptionist(form: FormData) {
  await act(form, "/dealerships", async () => {
    const user = await requireRole("OPERATOR");
    const id = uuid.parse(str(form, "id"));
    const receptionist = z.enum(RECEPTIONIST_STATUSES).parse(str(form, "receptionist"));
    const note = z.string().max(300).nullable().parse(opt(form, "note"));
    const checked = receptionist !== "UNKNOWN";
    await db()
      .update(dealerships)
      .set({ receptionist, receptionistNote: note, receptionistCheckedAt: checked ? new Date() : null, receptionistCheckedBy: checked ? user.email : null, updatedAt: new Date() })
      .where(eq(dealerships.id, id));
    await audit(user.email, "dealership.updated", "dealership", id, { fields: ["receptionist"], receptionist });
    return checked ? "Phone check recorded." : "Phone check cleared.";
  });
}

export async function setPipeline(form: FormData) {
  await act(form, "/dealerships", async () => {
    const user = await requireRole("OPERATOR");
    const id = uuid.parse(str(form, "id"));
    const stage = z.enum(PIPELINE_STAGES).parse(str(form, "stage"));
    const nextAction = opt(form, "nextAction");
    const due = opt(form, "nextActionDue");
    await db()
      .update(dealerships)
      .set({ pipelineStage: stage, nextAction, nextActionDue: due ? new Date(due) : null, updatedAt: new Date() })
      .where(eq(dealerships.id, id));
    await audit(user.email, "dealership.pipeline", "dealership", id, { stage, nextAction });
    return "Pipeline updated.";
  });
}

export async function setPriority(form: FormData) {
  await act(form, "/dealerships", async () => {
    const user = await requireRole("OPERATOR");
    const id = uuid.parse(str(form, "id"));
    const raw = str(form, "priorityOverride");
    const value = raw === "" ? null : z.coerce.number().int().min(0).max(100).parse(raw);
    await db().update(dealerships).set({ priorityOverride: value, updatedAt: new Date() }).where(eq(dealerships.id, id));
    await audit(user.email, "dealership.priority", "dealership", id, { priorityOverride: value });
    return value === null ? "Manual priority cleared." : `Manual priority set to ${value}.`;
  });
}

/** A person logs what happened with this dealership: called, no answer, booked a meeting, sold… */
export async function logSalesTouch(form: FormData) {
  await act(form, "/dealerships", async () => {
    const user = await requireRole("OPERATOR");
    const dealershipId = uuid.parse(str(form, "dealershipId"));
    const outcome = z.enum(SALES_OUTCOMES).parse(str(form, "outcome"));
    const note = z.string().max(4000).optional().parse(opt(form, "note") ?? undefined) ?? null;
    const now = new Date();
    await db().insert(salesTouches).values({ dealershipId, outcome, note, by: user.email });
    const nextAction = outcome === "CALLBACK" ? "Call back" : outcome === "NO_ANSWER" ? "Try again" : outcome === "BOOKED_MEETING" ? "Prepare for the meeting" : outcome === "SOLD" ? "Onboard the dealership" : outcome === "NOT_INTERESTED" ? null : "Follow up";
    await db()
      .update(dealerships)
      .set({ salesStatus: outcome, lastTouchAt: now, pipelineStage: SALES_OUTCOME_STAGE[outcome], nextAction, updatedAt: now })
      .where(eq(dealerships.id, dealershipId));
    await audit(user.email, "dealership.sales_touch", "dealership", dealershipId, { outcome, note: note?.slice(0, 200) ?? null });
    return `Logged: ${SALES_OUTCOME_LABEL[outcome]}.`;
  });
}

export async function addNote(form: FormData) {
  await act(form, "/dealerships", async () => {
    const user = await requireRole("OPERATOR");
    const dealershipId = uuid.parse(str(form, "dealershipId"));
    const body = z.string().min(1).max(4000).parse(str(form, "body"));
    await db().insert(notes).values({ dealershipId, author: user.email, body });
    return "Note added.";
  });
}

export async function addContact(form: FormData) {
  await act(form, "/dealerships", async () => {
    const user = await requireRole("OPERATOR");
    const input = z
      .object({ dealershipId: uuid, name: z.string().min(2).max(120), title: z.string().max(120).nullable(), email: z.string().email().nullable(), phone: z.string().max(40).nullable(), sourceUrl: httpUrl })
      .parse({ dealershipId: str(form, "dealershipId"), name: str(form, "name"), title: opt(form, "title"), email: opt(form, "email"), phone: opt(form, "phone"), sourceUrl: str(form, "sourceUrl") });
    const [row] = await db().insert(contacts).values({ ...input, addedBy: user.email }).returning({ id: contacts.id });
    await audit(user.email, "contact.created", "dealership", input.dealershipId, { contactId: row?.id, sourceUrl: input.sourceUrl });
    return "Contact added.";
  });
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

const groupInput = z.object({
  name: z.string().min(2).max(200),
  website: z.string().max(300).nullable(),
  headquarters: z.string().max(200).nullable(),
  storeCount: z.number().int().min(1).max(5000).nullable(),
  ownershipInformation: z.string().max(2000).nullable(),
});
const readGroup = (form: FormData) =>
  groupInput.parse({
    name: str(form, "name"),
    website: opt(form, "website"),
    headquarters: opt(form, "headquarters"),
    storeCount: str(form, "storeCount") ? Number(str(form, "storeCount")) : null,
    ownershipInformation: opt(form, "ownershipInformation"),
  });

export async function saveGroup(form: FormData) {
  await act(form, "/groups", async () => {
    const user = await requireRole("OPERATOR");
    const id = opt(form, "id");
    const input = readGroup(form);
    const website = input.website ? normalizeWebsite(input.website) : null;
    if (input.website && !website) throw new Error("Enter a valid website address.");
    const normalizedName = normalizeName(input.name);
    const [clash] = await db().select({ id: dealerGroups.id }).from(dealerGroups).where(eq(dealerGroups.normalizedName, normalizedName)).limit(1);
    if (clash && clash.id !== id) throw new Error(`A group named "${input.name}" already exists.`);
    const values = { ...input, website, normalizedName, normalizedDomain: dedupeKeys({ name: input.name, website }).normalizedDomain, updatedAt: new Date() };
    if (id) {
      await db().update(dealerGroups).set(values).where(eq(dealerGroups.id, uuid.parse(id)));
      await refreshGroupIntel(id);
      await audit(user.email, "group.updated", "group", id);
      return "Group updated.";
    }
    const [row] = await db().insert(dealerGroups).values(values).returning({ id: dealerGroups.id });
    await audit(user.email, "group.created", "group", row?.id ?? null, { name: input.name });
    return `redirect:/groups/${row?.id}`;
  });
}

export async function deleteGroup(form: FormData) {
  await act(form, "/groups", async () => {
    const user = await requireRole("ADMIN");
    const id = uuid.parse(str(form, "id"));
    await db().delete(dealerGroups).where(eq(dealerGroups.id, id));
    await syncSuppressionFlags();
    await audit(user.email, "group.deleted", "group", id);
    return "redirect:/groups?notice=Group%20deleted.%20Its%20rooftops%20were%20kept.";
  });
}

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

export async function suppress(form: FormData) {
  await act(form, "/suppression", async () => {
    const user = await requireRole("OPERATOR");
    const scope = z.enum(SUPPRESSION_SCOPES).parse(str(form, "scope"));
    const expires = opt(form, "expiresAt");
    await createSuppression(
      {
        scope,
        dealershipId: opt(form, "dealershipId"),
        groupId: opt(form, "groupId"),
        domain: opt(form, "domain"),
        phone: opt(form, "phone"),
        reason: z.enum(SUPPRESSION_REASONS).parse(str(form, "reason")),
        note: opt(form, "note"),
        includeRooftops: form.get("includeRooftops") !== "false",
        expiresAt: expires ? new Date(expires) : null,
      },
      user.email,
    );
    // Anything waiting for approval on a now-suppressed rooftop is cancelled outright.
    const suppressed = await db().select({ id: dealerships.id }).from(dealerships).where(eq(dealerships.suppressed, true));
    if (suppressed.length) {
      await db()
        .update(testInteractions)
        .set({ status: "CANCELLED", statusDetail: "Dealership was suppressed", completedAt: new Date() })
        .where(and(inArray(testInteractions.dealershipId, suppressed.map((s) => s.id)), inArray(testInteractions.status, ["PENDING_APPROVAL", "APPROVED"])));
    }
    return "Suppression added. No tests will run against it.";
  });
}

export async function unsuppress(form: FormData) {
  await act(form, "/suppression", async () => {
    const user = await requireRole("OPERATOR");
    await liftSuppression(uuid.parse(str(form, "id")), user.email);
    return "Suppression lifted.";
  });
}

// ---------------------------------------------------------------------------
// Controlled interactions
// ---------------------------------------------------------------------------

export async function requestInteraction(form: FormData) {
  await act(form, "/interactions", async () => {
    const user = await requireRole("OPERATOR");
    const dealershipId = uuid.parse(str(form, "dealershipId"));
    const identityId = uuid.parse(str(form, "identityId"));
    const formIndex = z.coerce.number().int().min(0).parse(str(form, "formIndex"));
    const message = z.enum(APPROVED_MESSAGES).parse(str(form, "message"));

    const [obs] = await db()
      .select({ leadForms: websiteObservations.leadForms })
      .from(websiteObservations)
      .where(and(eq(websiteObservations.dealershipId, dealershipId), eq(websiteObservations.websiteStatus, "OK")))
      .orderBy(desc(websiteObservations.timestamp))
      .limit(1);
    const target = obs?.leadForms[formIndex];
    if (!target) throw new Error("That form is no longer in the latest scan. Run a website scan and pick again.");

    const eligibility = await checkEligibility({ dealershipId, identityId, targetUrl: target.pageUrl, formType: target.type, form: target });
    const base = { dealershipId, identityId, testType: "FORM" as const, formType: target.type, message, sourceUrl: target.pageUrl, requestedBy: user.email };
    if (!eligibility.eligible) {
      const detail = eligibility.reasons.map((r) => r.message).join(" ");
      // Skips are recorded, not just refused, so there is a log of why a test did not run.
      const [row] = await db().insert(testInteractions).values({ ...base, status: "SKIPPED", statusDetail: detail, completedAt: new Date() }).returning({ id: testInteractions.id });
      await audit(user.email, "test.skipped", "interaction", row?.id ?? null, { dealershipId, reasons: eligibility.reasons.map((r) => r.code) });
      await emit("Form test request refused", { agent: "orion", dealershipId, interactionId: row?.id ?? null, detail, status: "BLOCKED", kind: "task.blocked" });
      throw new Error(`Test not created. ${detail}`);
    }
    const [row] = await db().insert(testInteractions).values({ ...base, status: "PENDING_APPROVAL" }).returning({ id: testInteractions.id });
    await audit(user.email, "test.requested", "interaction", row?.id ?? null, { dealershipId, formType: target.type, url: target.pageUrl });
    return "Test requested. It will not run until someone approves it.";
  });
}

/** Queues an automated chat test: one approved question through the site's chat widget, as the test identity. */
export async function requestChatTest(form: FormData) {
  await act(form, "/interactions", async () => {
    const user = await requireRole("OPERATOR");
    const dealershipId = uuid.parse(str(form, "dealershipId"));
    const identityId = uuid.parse(str(form, "identityId"));
    const sourceUrl = httpUrl.parse(str(form, "sourceUrl"));
    const message = z.enum(APPROVED_MESSAGES).parse(str(form, "message"));
    const eligibility = await checkEligibility({ dealershipId, identityId, targetUrl: sourceUrl, testType: "CHAT", formType: null, form: null });
    const base = { dealershipId, identityId, testType: "CHAT" as const, formType: null, message, sourceUrl, requestedBy: user.email };
    if (!eligibility.eligible) {
      const detail = eligibility.reasons.map((r) => r.message).join(" ");
      const [row] = await db().insert(testInteractions).values({ ...base, status: "SKIPPED", statusDetail: detail, completedAt: new Date() }).returning({ id: testInteractions.id });
      await audit(user.email, "test.skipped", "interaction", row?.id ?? null, { dealershipId, reasons: eligibility.reasons.map((r) => r.code), type: "CHAT" });
      await emit("Chat test request refused", { agent: "orion", dealershipId, interactionId: row?.id ?? null, detail, status: "BLOCKED", kind: "task.blocked" });
      throw new Error(`Chat test not created. ${detail}`);
    }
    const [row] = await db().insert(testInteractions).values({ ...base, status: "PENDING_APPROVAL" }).returning({ id: testInteractions.id });
    await audit(user.email, "test.requested", "interaction", row?.id ?? null, { dealershipId, type: "CHAT", url: sourceUrl });
    return "Chat test requested. It will not run until someone approves it.";
  });
}

export async function approveInteraction(form: FormData) {
  await act(form, "/interactions", async () => {
    const user = await requireRole("OPERATOR");
    const id = uuid.parse(str(form, "id"));
    const [i] = await db().select().from(testInteractions).where(eq(testInteractions.id, id)).limit(1);
    if (!i || i.status !== "PENDING_APPROVAL") throw new Error("This test is not waiting for approval.");
    const eligibility = await checkEligibility({ dealershipId: i.dealershipId, identityId: i.identityId, targetUrl: i.sourceUrl, testType: i.testType, formType: i.formType, form: null, excludeInteractionId: id });
    if (!eligibility.eligible) {
      const detail = eligibility.reasons.map((r) => r.message).join(" ");
      await db().update(testInteractions).set({ status: "SKIPPED", statusDetail: detail, completedAt: new Date() }).where(eq(testInteractions.id, id));
      await audit(user.email, "test.skipped", "interaction", id, { reasons: eligibility.reasons.map((r) => r.code) });
      throw new Error(`Not approved — the test was skipped. ${detail}`);
    }
    await db().update(testInteractions).set({ status: "APPROVED", approvedBy: user.email, approvedAt: new Date() }).where(and(eq(testInteractions.id, id), eq(testInteractions.status, "PENDING_APPROVAL")));
    await audit(user.email, "test.approved", "interaction", id, { dealershipId: i.dealershipId });
    await enqueue("interaction", { interactionId: id, dealershipId: i.dealershipId, manual: true });
    await audit(user.email, "interaction.triggered", "interaction", id, { dealershipId: i.dealershipId });
    await emit(`${i.testType === "CHAT" ? "Chat" : "Form"} test approved and handed to Charlie`, { agent: "orion", dealershipId: i.dealershipId, interactionId: id, detail: `by ${user.email}`, status: "DONE", kind: "task.created" });
    return "Approved. The inquiry will be submitted shortly and the response timer will start.";
  });
}

/** Charlie calls the dealership's number once and records what answers. Needs testing approval and Twilio. */
export async function queuePhoneCheck(form: FormData) {
  await act(form, "/dealerships", async () => {
    const user = await requireRole("OPERATOR");
    const dealershipId = uuid.parse(str(form, "dealershipId"));
    const [d] = await db().select({ testingApproved: dealerships.testingApproved, phone: dealerships.phone, suppressed: dealerships.suppressed }).from(dealerships).where(eq(dealerships.id, dealershipId)).limit(1);
    if (!d) throw new Error("Dealership not found.");
    if (!d.testingApproved) throw new Error("Approve this dealership for testing first.");
    if (d.suppressed) throw new Error("This dealership is suppressed.");
    if (!d.phone) throw new Error("No phone number on file.");
    const result = await enqueue("phone-check", { dealershipId, manual: true });
    await audit(user.email, "job.enqueued", "dealership", dealershipId, { queue: "phone-check", queued: result.queued });
    await emit(`Phone check requested by ${user.email}`, { agent: "orion", dealershipId, kind: "task.created" });
    return result.queued ? "Charlie is placing the call. The result appears under AI receptionist in a minute or two." : "A phone check is already running for this dealership.";
  });
}

/** Approves every test waiting for approval, one by one, with the same checks as a single approval. */
export async function approveAllPending(form: FormData) {
  await act(form, "/interactions", async () => {
    const user = await requireRole("OPERATOR");
    const pending = await db().select({ id: testInteractions.id, dealershipId: testInteractions.dealershipId, testType: testInteractions.testType, identityId: testInteractions.identityId, sourceUrl: testInteractions.sourceUrl, formType: testInteractions.formType }).from(testInteractions).where(eq(testInteractions.status, "PENDING_APPROVAL"));
    let approved = 0;
    let skipped = 0;
    for (const i of pending) {
      const eligibility = await checkEligibility({ dealershipId: i.dealershipId, identityId: i.identityId, targetUrl: i.sourceUrl, testType: i.testType, formType: i.formType, form: null, excludeInteractionId: i.id });
      if (!eligibility.eligible) {
        const detail = eligibility.reasons.map((r) => r.message).join(" ");
        await db().update(testInteractions).set({ status: "SKIPPED", statusDetail: detail, completedAt: new Date() }).where(eq(testInteractions.id, i.id));
        await audit(user.email, "test.skipped", "interaction", i.id, { reasons: eligibility.reasons.map((r) => r.code) });
        skipped += 1;
        continue;
      }
      await db().update(testInteractions).set({ status: "APPROVED", approvedBy: user.email, approvedAt: new Date() }).where(and(eq(testInteractions.id, i.id), eq(testInteractions.status, "PENDING_APPROVAL")));
      await audit(user.email, "test.approved", "interaction", i.id, { dealershipId: i.dealershipId, bulk: true });
      await enqueue("interaction", { interactionId: i.id, dealershipId: i.dealershipId, manual: true });
      await emit(`${i.testType === "CHAT" ? "Chat" : "Form"} test approved and handed to Charlie`, { agent: "orion", dealershipId: i.dealershipId, interactionId: i.id, detail: `by ${user.email} (approve all)`, status: "DONE", kind: "task.created" });
      approved += 1;
    }
    return `Approved ${approved} test(s)${skipped ? `; ${skipped} skipped by policy` : ""}. Charlie runs them one at a time.`;
  });
}

export async function cancelInteraction(form: FormData) {
  await act(form, "/interactions", async () => {
    const user = await requireRole("OPERATOR");
    const id = uuid.parse(str(form, "id"));
    const [row] = await db()
      .update(testInteractions)
      .set({ status: "CANCELLED", statusDetail: `Cancelled by ${user.email}`, completedAt: new Date() })
      .where(and(eq(testInteractions.id, id), inArray(testInteractions.status, ["PENDING_APPROVAL", "APPROVED"])))
      .returning({ id: testInteractions.id });
    if (!row) throw new Error("Only tests that have not started can be cancelled.");
    await audit(user.email, "test.cancelled", "interaction", id);
    return "Test cancelled.";
  });
}

export async function recordManualResponse(form: FormData) {
  await act(form, "/interactions", async () => {
    const user = await requireRole("OPERATOR");
    const input = z
      .object({ interactionId: uuid, channel: z.enum(CHANNELS), receivedAt: z.coerce.date(), sender: z.string().max(200).nullable(), message: z.string().max(10_000).nullable() })
      .parse({ interactionId: str(form, "interactionId"), channel: str(form, "channel"), receivedAt: str(form, "receivedAt"), sender: opt(form, "sender"), message: opt(form, "message") });
    if (input.receivedAt.getTime() > Date.now() + 5 * 60_000) throw new Error("The response time is in the future.");
    const result = await recordResponse({ ...input, ingestedVia: "MANUAL", externalId: null, actor: user.email });
    if ("duplicate" in result) return "That response was already recorded.";
    const unmatchedId = opt(form, "unmatchedId");
    if (unmatchedId) await db().update(unmatchedInbound).set({ resolvedInteractionId: input.interactionId }).where(eq(unmatchedInbound.id, uuid.parse(unmatchedId)));
    return `Response recorded: ${result.responseSeconds} seconds after submission.`;
  });
}

/** Logs a chat test an operator ran by hand. Automated chat testing is not part of V1. */
export async function logChatTest(form: FormData) {
  await act(form, "/interactions", async () => {
    const user = await requireRole("OPERATOR");
    const settings = await getSettings();
    const input = z
      .object({
        dealershipId: uuid,
        startedAt: z.coerce.date(),
        sourceUrl: httpUrl,
        chatWorking: z.boolean(),
        contactRequired: z.boolean(),
        chatQuality: z.number().int().min(0).max(100).nullable(),
        transcript: z.string().min(1).max(20_000),
      })
      .parse({
        dealershipId: str(form, "dealershipId"),
        startedAt: str(form, "startedAt"),
        sourceUrl: str(form, "sourceUrl"),
        chatWorking: str(form, "chatWorking") === "true",
        contactRequired: str(form, "contactRequired") === "true",
        chatQuality: str(form, "chatQuality") ? Number(str(form, "chatQuality")) : null,
        transcript: str(form, "transcript"),
      });
    // Transcript format: one message per line, prefixed "me:" (researcher) or "them:" (dealership).
    const lines = input.transcript.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const messages = lines.map((l) => {
      const m = /^(me|them)\s*:\s*(.+)$/i.exec(l);
      if (!m) throw new Error(`Each transcript line must start with "me:" or "them:". Problem line: "${l.slice(0, 60)}"`);
      return { speaker: m[1]!.toLowerCase() === "me" ? "RESEARCHER" : "DEALERSHIP", message: redactSecrets(m[2]!) ?? "" };
    });
    const mine = messages.filter((m) => m.speaker === "RESEARCHER").length;
    const limit = Math.min(settings.maxChatMessages, env().MAX_CHAT_MESSAGES);
    if (mine > limit) throw new Error(`This transcript has ${mine} researcher messages; the limit is ${limit}.`);

    const [obs] = await db().select({ id: websiteObservations.id }).from(websiteObservations).where(eq(websiteObservations.dealershipId, input.dealershipId)).orderBy(desc(websiteObservations.timestamp)).limit(1);
    if (!obs) throw new Error("Scan the website before logging a chat test.");
    const [row] = await db()
      .insert(testInteractions)
      .values({ dealershipId: input.dealershipId, testType: "CHAT", status: "COMPLETED", sourceUrl: input.sourceUrl, requestedBy: user.email, approvedBy: user.email, startedAt: input.startedAt, submittedAt: input.startedAt, completedAt: new Date(), statusDetail: "Run by hand and logged by an operator" })
      .returning({ id: testInteractions.id });
    if (!row) throw new Error("Could not log the chat test.");
    await db().insert(transcriptMessages).values(messages.map((m, idx) => ({ interactionId: row.id, dealershipId: input.dealershipId, timestamp: new Date(input.startedAt.getTime() + idx * 1000), speaker: m.speaker, channel: "CHAT" as const, message: m.message })));
    // Screenshots of the conversation are the evidence a salesperson can show; up to 5, images only.
    const shots = form.getAll("screenshots").filter((f): f is File => f instanceof File && f.size > 0).slice(0, 5);
    for (const shot of shots) {
      const contentType = shot.type === "image/png" ? "image/png" : shot.type === "image/jpeg" ? "image/jpeg" : null;
      if (!contentType) throw new Error(`"${shot.name}" is not a PNG or JPEG image.`);
      if (shot.size > 8_000_000) throw new Error(`"${shot.name}" is larger than 8 MB.`);
      await saveScreenshot({ dealershipId: input.dealershipId, type: "CHAT", body: Buffer.from(await shot.arrayBuffer()), sourceUrl: input.sourceUrl, interactionId: row.id, capturedAt: input.startedAt, contentType });
    }
    await db().update(websiteObservations).set({ chatWorking: input.chatWorking, contactRequired: input.contactRequired, chatQuality: input.chatQuality }).where(eq(websiteObservations.id, obs.id));
    await audit(user.email, "test.submitted", "interaction", row.id, { dealershipId: input.dealershipId, type: "CHAT", manual: true });
    await enqueue("scoring", { dealershipId: input.dealershipId });
    return shots.length ? `Chat test logged with ${shots.length} screenshot(s).` : "Chat test logged.";
  });
}

// ---------------------------------------------------------------------------
// Signals & social (operator-entered, always with a source)
// ---------------------------------------------------------------------------

export async function createSignal(form: FormData) {
  await act(form, "/signals", async () => {
    const user = await requireRole("OPERATOR");
    const input = z
      .object({ dealershipId: uuid.nullable(), groupId: uuid.nullable(), type: z.enum(SIGNAL_TYPES), title: z.string().min(3).max(200), description: z.string().max(2000).nullable(), sourceUrl: httpUrl, confidence: z.enum(CONFIDENCE) })
      .parse({ dealershipId: opt(form, "dealershipId"), groupId: opt(form, "groupId"), type: str(form, "type"), title: str(form, "title"), description: opt(form, "description"), sourceUrl: str(form, "sourceUrl"), confidence: str(form, "confidence") });
    if (!input.dealershipId && !input.groupId) throw new Error("Choose a dealership or a group for this signal.");
    const dedupeKey = createHash("sha1").update(`${input.dealershipId ?? input.groupId}|${input.type}|${input.title.toLowerCase()}`).digest("hex");
    const [row] = await db().insert(signals).values({ ...input, kind: "OBSERVED", source: "MANUAL", dedupeKey }).onConflictDoNothing().returning({ id: signals.id });
    if (!row) throw new Error("That signal is already on file.");
    await audit(user.email, "signal.created", "signal", row.id, { type: input.type, sourceUrl: input.sourceUrl });
    if (input.dealershipId) await enqueue("scoring", { dealershipId: input.dealershipId });
    return "Signal added.";
  });
}

export async function recordSocial(form: FormData) {
  await act(form, "/dealerships", async () => {
    const user = await requireRole("OPERATOR");
    const n = (key: string) => (str(form, key) === "" ? null : z.coerce.number().int().min(0).max(100_000).parse(str(form, key)));
    const input = z
      .object({ dealershipId: uuid, platform: z.string().min(2).max(30), sourceUrl: httpUrl, confidence: z.enum(CONFIDENCE), notes: z.string().max(2000).nullable() })
      .parse({ dealershipId: str(form, "dealershipId"), platform: str(form, "platform").toLowerCase(), sourceUrl: str(form, "sourceUrl"), confidence: str(form, "confidence"), notes: opt(form, "notes") });
    const ads = str(form, "adActivity");
    await db().insert(socialObservations).values({
      ...input,
      source: "MANUAL",
      recordedBy: user.email,
      postsLast30Days: n("postsLast30Days"),
      inventoryPostsLast30Days: n("inventoryPostsLast30Days"),
      customerQuestions: n("customerQuestions"),
      unansweredQuestions: n("unansweredQuestions"),
      adActivity: ads === "" ? null : ads === "true",
    });
    await audit(user.email, "social.recorded", "dealership", input.dealershipId, { platform: input.platform, sourceUrl: input.sourceUrl });
    await enqueue("scoring", { dealershipId: input.dealershipId });
    return "Social observation recorded.";
  });
}

// ---------------------------------------------------------------------------
// Settings, identities, users
// ---------------------------------------------------------------------------

export async function saveSettings(form: FormData) {
  await act(form, "/settings", async () => {
    const user = await requireRole("ADMIN");
    const num = (k: string) => Number(str(form, k));
    const patch = settingsSchema
      .omit({ scoringWeights: true, scoringThresholds: true })
      .parse({
        testingEnabled: form.get("testingEnabled") === "on",
        interactionCooldownDays: num("interactionCooldownDays"),
        maxChatMessages: num("maxChatMessages"),
        maxHumanReplies: num("maxHumanReplies"),
        responseMonitorHours: num("responseMonitorHours"),
        websiteScanIntervalDays: num("websiteScanIntervalDays"),
        inventoryScanIntervalDays: num("inventoryScanIntervalDays"),
        socialScanIntervalDays: num("socialScanIntervalDays"),
        signalScanIntervalDays: num("signalScanIntervalDays"),
        aiProvider: str(form, "aiProvider"),
        aiModel: str(form, "aiModel"),
        prospectingEnabled: form.get("prospectingEnabled") === "on",
        prospectIntervalSeconds: Number(str(form, "prospectIntervalSeconds")),
        prospectingAroundTheClock: form.get("prospectingAroundTheClock") === "on",
        prospectCenterLat: Number(str(form, "prospectCenterLat")),
        prospectCenterLng: Number(str(form, "prospectCenterLng")),
        prospectRadiusKm: Number(str(form, "prospectRadiusKm")),
        prospectNationwide: form.get("prospectNationwide") === "on",
        chatTestMode: str(form, "chatTestMode"),
        phoneCheckScript: str(form, "phoneCheckScript"),
        phoneCheckMode: str(form, "phoneCheckMode"),
        phoneHangUpOnHuman: form.get("phoneHangUpOnHuman") === "on",
        researchPresentation: str(form, "researchPresentation"),
        researchWindowEnabled: form.get("researchWindowEnabled") === "on",
        researchWindowStart: str(form, "researchWindowStart"),
        researchWindowEnd: str(form, "researchWindowEnd"),
        timezone: str(form, "timezone"),
        maxAIRequestsPerJob: num("maxAIRequestsPerJob"),
        maxAITokensPerJob: num("maxAITokensPerJob"),
        screenshotRetentionDays: num("screenshotRetentionDays"),
        evidenceRetentionDays: num("evidenceRetentionDays"),
      });
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: patch.timezone });
    } catch {
      throw new Error(`"${patch.timezone}" is not a valid time zone. Use an IANA name such as America/Chicago.`);
    }
    const before = await getSettings();
    await updateSettings(patch, user.email);
    const changed = Object.fromEntries(Object.entries(patch).filter(([k, v]) => before[k as keyof typeof before] !== v));
    await audit(user.email, "settings.changed", "settings", null, { changed });
    return "Settings saved.";
  });
}

/** Pause or resume one agent's queue. Paused queues keep accepting jobs; nothing runs until resumed. */
export async function setAgentPaused(form: FormData) {
  await act(form, "/agents", async () => {
    const user = await requireRole("ADMIN");
    const queue = z.enum(QUEUES).parse(str(form, "queue"));
    const paused = str(form, "paused") === "true";
    if (paused) await getQueue(queue).pause();
    else await getQueue(queue).resume();
    await audit(user.email, "settings.changed", "agent", queue, { paused });
    return paused ? `${queue} paused. Queued work waits until it is resumed.` : `${queue} resumed.`;
  });
}

export async function saveScoring(form: FormData) {
  await act(form, "/settings", async () => {
    const user = await requireRole("ADMIN");
    const weights = Object.fromEntries(RULES.map((r) => [r.id, z.coerce.number().int().min(0).max(100).parse(str(form, `w:${r.id}`))]));
    const before = await getSettings();
    const thresholds = Object.fromEntries(Object.keys(before.scoringThresholds).map((k) => [k, Number(str(form, `t:${k}`))]));
    await updateSettings({ scoringWeights: weights, scoringThresholds: settingsSchema.shape.scoringThresholds.parse(thresholds) }, user.email);
    await audit(user.email, "settings.changed", "settings", "scoring", {
      weights: Object.fromEntries(Object.entries(weights).filter(([k, v]) => before.scoringWeights[k] !== v)),
      thresholds,
    });
    // New weights apply to everyone, so every rooftop is re-scored.
    const all = await db().select({ id: dealerships.id }).from(dealerships);
    for (const d of all) await enqueue("scoring", { dealershipId: d.id });
    return `Scoring rules saved. Re-scoring ${all.length} dealership(s).`;
  });
}

export async function createIdentity(form: FormData) {
  await act(form, "/settings", async () => {
    const user = await requireRole("ADMIN");
    if (form.get("authorized") !== "on") throw new Error("Confirm that this identity is company-owned and you are authorised to use it.");
    const input = z
      .object({ name: z.string().min(2).max(120), email: z.string().email(), phone: z.string().min(7).max(40), address: z.string().max(300).nullable() })
      .parse({ name: str(form, "name"), email: str(form, "email").toLowerCase(), phone: str(form, "phone"), address: opt(form, "address") });
    const normalizedPhone = normalizePhone(input.phone);
    if (!normalizedPhone) throw new Error("Enter a valid 10-digit phone number.");
    const [row] = await db().insert(testIdentities).values({ ...input, normalizedPhone, createdBy: user.email }).onConflictDoNothing().returning({ id: testIdentities.id });
    if (!row) throw new Error("An identity with that email already exists.");
    await audit(user.email, "identity.created", "identity", row.id, { email: input.email });
    return "Test identity added.";
  });
}

export async function toggleIdentity(form: FormData) {
  await act(form, "/settings", async () => {
    const user = await requireRole("ADMIN");
    const id = uuid.parse(str(form, "id"));
    const active = str(form, "active") === "true";
    await db().update(testIdentities).set({ active }).where(eq(testIdentities.id, id));
    await audit(user.email, "identity.updated", "identity", id, { active });
    return active ? "Identity activated." : "Identity deactivated.";
  });
}

export async function createUser(form: FormData) {
  await act(form, "/settings", async () => {
    const admin = await requireRole("ADMIN");
    const input = z
      .object({ name: z.string().min(2).max(120), email: z.string().email(), role: z.enum(ROLES), password: z.string().min(12, "Password must be at least 12 characters").max(200) })
      .parse({ name: str(form, "name"), email: str(form, "email").toLowerCase(), role: str(form, "role"), password: str(form, "password") });
    const [row] = await db()
      .insert(users)
      .values({ name: input.name, email: input.email, role: input.role, passwordHash: hashPassword(input.password) })
      .onConflictDoNothing()
      .returning({ id: users.id });
    if (!row) throw new Error("A user with that email already exists.");
    await audit(admin.email, "user.created", "user", row.id, { email: input.email, role: input.role });
    return "User added.";
  });
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export async function retryJob(form: FormData) {
  await act(form, "/jobs", async () => {
    const user = await requireRole("OPERATOR");
    const [run] = await db().select().from(jobRuns).where(eq(jobRuns.id, uuid.parse(str(form, "id")))).limit(1);
    if (!run) throw new Error("Job run not found.");
    const queue = z.enum(QUEUES).parse(run.queue) as QueueName;
    // A form submission is never re-run from here: it needs a fresh request and approval.
    if (queue === "interaction") throw new Error("Interactions cannot be retried. Request and approve a new test instead.");
    const job = await getQueue(queue).getJob(run.jobId);
    if (job && (await job.getState()) === "failed") await job.retry();
    else await enqueue(queue, run.payload as JobPayloads[typeof queue]);
    await audit(user.email, "job.retried", "job", run.jobId, { queue });
    return "Job queued again.";
  });
}
