import { and, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { dealerships, testIdentities, testInteractions, type DetectedForm } from "@/db/schema";
import { env } from "@/env";
import { normalizeDomain } from "@/lib/normalize";
import { getSettings } from "@/lib/settings";
import { ACTIVE_INTERACTION_STATUSES, SUBMITTABLE_FORM_TYPES, type FormType } from "./constants";
import { checkSuppression } from "./suppression";

export type SkipCode =
  | "TESTING_DISABLED"
  | "TEST_LIMIT_ZERO"
  | "DEALERSHIP_NOT_FOUND"
  | "NOT_APPROVED"
  | "PAUSED"
  | "SUPPRESSED"
  | "COOLDOWN"
  | "ACTIVE_TEST"
  | "NO_IDENTITY"
  | "NO_DOMAIN"
  | "DOMAIN_MISMATCH"
  | "FORM_TYPE_NOT_ALLOWED"
  | "PROHIBITED_FIELDS"
  | "CAPTCHA_PRESENT";

export type SkipReason = { code: SkipCode; message: string };

export type EligibilityInput = {
  now: Date;
  testingEnabled: boolean;
  /** Env ceiling: 0 disables all testing regardless of admin settings. */
  maxTestsPer30Days: number;
  cooldownDays: number;
  dealership: { paused: boolean; testingApproved: boolean; normalizedDomain: string | null } | null;
  suppressed: boolean;
  identity: { active: boolean } | null;
  /** FORM submits an inquiry form; CHAT sends one question through the site's chat widget. */
  testType: "FORM" | "CHAT";
  /** Most recent time a test of this type was actually submitted to this rooftop. */
  lastSubmittedAt: Date | null;
  /** Other interactions of this type for this rooftop that are pending, approved, running or being monitored. */
  activeInteractions: number;
  /** Page the form lives on. Must be on the dealership's own domain. */
  targetUrl: string | null;
  formType: FormType | null;
  form: Pick<DetectedForm, "hasProhibitedFields" | "hasCaptcha"> | null;
};

export type EligibilityResult = { eligible: boolean; reasons: SkipReason[]; retestAfter: Date | null };

/**
 * The single gate every controlled interaction passes through — when it is requested, when it is
 * approved, and again in the worker immediately before the browser opens. Pure: all inputs are
 * passed in, so every rule is unit-tested without a database.
 *
 * Every failing rule is reported (not just the first) so the skip log explains itself.
 */
export function evaluateEligibility(i: EligibilityInput): EligibilityResult {
  const reasons: SkipReason[] = [];
  const add = (code: SkipCode, message: string) => reasons.push({ code, message });
  let retestAfter: Date | null = null;

  if (!i.testingEnabled) add("TESTING_DISABLED", "Controlled testing is switched off in Settings.");
  if (i.maxTestsPer30Days < 1) add("TEST_LIMIT_ZERO", "MAX_TESTS_PER_DEALERSHIP_PER_30_DAYS is 0.");

  if (!i.dealership) {
    add("DEALERSHIP_NOT_FOUND", "Dealership not found.");
    return { eligible: false, reasons, retestAfter };
  }
  if (!i.dealership.testingApproved) add("NOT_APPROVED", "This dealership has not been approved for testing.");
  if (i.dealership.paused) add("PAUSED", "This dealership is paused.");
  if (i.suppressed) add("SUPPRESSED", "This dealership is suppressed.");

  if (i.lastSubmittedAt) {
    // The env limit of one test per 30 days is a floor under whatever the admin configured.
    const days = Math.max(i.cooldownDays, 30);
    const until = new Date(i.lastSubmittedAt.getTime() + days * 86_400_000);
    if (until.getTime() > i.now.getTime()) {
      retestAfter = until;
      add("COOLDOWN", `Last tested ${i.lastSubmittedAt.toISOString().slice(0, 10)}; cooldown runs until ${until.toISOString().slice(0, 10)}.`);
    }
  }
  if (i.activeInteractions > 0) add("ACTIVE_TEST", "Another test for this dealership is already pending or in progress.");

  if (!i.identity) add("NO_IDENTITY", "No approved test identity is configured.");
  else if (!i.identity.active) add("NO_IDENTITY", "The selected test identity is inactive.");

  if (!i.dealership.normalizedDomain) add("NO_DOMAIN", "The dealership has no website on file.");
  else if (!i.targetUrl || normalizeDomain(i.targetUrl) !== i.dealership.normalizedDomain) {
    add("DOMAIN_MISMATCH", `The ${i.testType === "CHAT" ? "page" : "form"} URL is not on the dealership's own domain.`);
  }

  if (i.testType === "FORM") {
    if (!i.formType || !SUBMITTABLE_FORM_TYPES.includes(i.formType)) {
      add("FORM_TYPE_NOT_ALLOWED", `Form type ${i.formType ?? "unknown"} is never submitted.`);
    }
    if (i.form?.hasProhibitedFields) add("PROHIBITED_FIELDS", "The form asks for finance, trade-in, appointment or test-drive details.");
    if (i.form?.hasCaptcha) add("CAPTCHA_PRESENT", "The form is protected by a CAPTCHA; it will not be bypassed.");
  }

  return { eligible: reasons.length === 0, reasons, retestAfter };
}

/** Gathers live inputs from the database and runs the gate. `excludeInteractionId` is the interaction being evaluated. */
export async function checkEligibility(args: {
  dealershipId: string;
  identityId: string | null;
  targetUrl: string | null;
  testType?: "FORM" | "CHAT";
  formType: FormType | null;
  form: Pick<DetectedForm, "hasProhibitedFields" | "hasCaptcha"> | null;
  excludeInteractionId?: string;
  now?: Date;
}): Promise<EligibilityResult> {
  const now = args.now ?? new Date();
  const testType = args.testType ?? "FORM";
  const [settings, [dealership], suppression] = await Promise.all([
    getSettings(),
    db()
      .select({ paused: dealerships.paused, testingApproved: dealerships.testingApproved, normalizedDomain: dealerships.normalizedDomain })
      .from(dealerships)
      .where(eq(dealerships.id, args.dealershipId))
      .limit(1),
    checkSuppression(args.dealershipId),
  ]);

  const [[identity], [last], active] = await Promise.all([
    args.identityId ? db().select({ active: testIdentities.active }).from(testIdentities).where(eq(testIdentities.id, args.identityId)).limit(1) : Promise.resolve([]),
    db()
      .select({ submittedAt: testInteractions.submittedAt })
      .from(testInteractions)
      .where(and(eq(testInteractions.dealershipId, args.dealershipId), eq(testInteractions.testType, testType), isNotNull(testInteractions.submittedAt)))
      .orderBy(desc(testInteractions.submittedAt))
      .limit(1),
    db()
      .select({ id: testInteractions.id })
      .from(testInteractions)
      .where(
        and(
          eq(testInteractions.dealershipId, args.dealershipId),
          // A form test being monitored for replies does not block a chat test, and vice versa;
          // the interaction queue runs one browser job at a time regardless.
          eq(testInteractions.testType, testType),
          inArray(testInteractions.status, [...ACTIVE_INTERACTION_STATUSES]),
          // A MONITORING interaction older than the cooldown window can't block forever.
          gte(testInteractions.createdAt, new Date(now.getTime() - 365 * 86_400_000)),
        ),
      ),
  ]);

  return evaluateEligibility({
    now,
    testingEnabled: settings.testingEnabled,
    maxTestsPer30Days: env().MAX_TESTS_PER_DEALERSHIP_PER_30_DAYS,
    cooldownDays: settings.interactionCooldownDays,
    dealership: dealership ?? null,
    suppressed: suppression.suppressed,
    identity: identity ?? null,
    testType,
    lastSubmittedAt: last?.submittedAt ?? null,
    activeInteractions: active.filter((a) => a.id !== args.excludeInteractionId).length,
    targetUrl: args.targetUrl,
    formType: args.formType,
    form: args.form,
  });
}
