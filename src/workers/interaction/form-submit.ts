import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { dealerships, testIdentities, testInteractions, transcriptMessages, websiteObservations, type TestIdentity } from "@/db/schema";
import { checkEligibility } from "@/domain/eligibility";
import { audit } from "@/lib/audit";
import { saveScreenshot } from "@/lib/evidence";
import { getSettings } from "@/lib/settings";
import { enqueue } from "@/queue";
import { Crawler } from "../website/crawler";
import { emit } from "@/lib/agent-events";
import { classifyForms } from "../website/detect";

import { APPROVED_MESSAGES } from "@/domain/constants";
export { APPROVED_MESSAGES };

type FieldPlan = { index: number; action: "fill" | "check" | "select"; value: string };

const CONSENT = /consent|agree|terms|privacy|i accept|acknowledge/i;

/**
 * Decides what goes in each visible field. Returns an error instead of a plan when a required field
 * is one we don't recognise — the form is then left untouched rather than submitted with a guess.
 */
export function planFields(
  fields: { name: string; label: string; type: string; required: boolean }[],
  identity: Pick<TestIdentity, "name" | "email" | "phone">,
  message: string,
): { plan: FieldPlan[] } | { error: string } {
  const [first, ...rest] = identity.name.trim().split(/\s+/);
  const last = rest.join(" ");
  const plan: FieldPlan[] = [];
  for (const [index, f] of fields.entries()) {
    const key = `${f.name} ${f.label}`.toLowerCase();
    let value: string | null = null;
    const action: FieldPlan["action"] = "fill";

    if (f.type === "checkbox" || f.type === "radio") {
      // Only required consent boxes are ticked; optional marketing opt-ins are left alone.
      if (f.type === "checkbox" && f.required && CONSENT.test(key)) plan.push({ index, action: "check", value: "" });
      else if (f.required) return { error: `Required ${f.type} "${f.label || f.name}" is not supported` };
      continue;
    }
    if (f.type === "select") {
      if (/contact.*(method|pref)|prefer|how.*(reach|contact)/.test(key)) {
        plan.push({ index, action: "select", value: "text|sms|email" });
        continue;
      }
      if (f.required) return { error: `Required drop-down "${f.label || f.name}" is not supported` };
      continue;
    }
    if (f.type === "file" || f.type === "password" || f.type === "date" || f.type === "time" || f.type === "datetime-local") {
      if (f.required) return { error: `Required ${f.type} field "${f.label || f.name}" is not supported` };
      continue;
    }

    if (/e-?mail/.test(key) || f.type === "email") value = identity.email;
    else if (/phone|mobile|cell|\btel\b/.test(key) || f.type === "tel") value = identity.phone;
    else if (/first.?name|fname|given/.test(key)) value = first ?? identity.name;
    else if (/last.?name|lname|surname|family/.test(key)) value = last || first || identity.name;
    else if (/name/.test(key)) value = identity.name;
    else if (f.type === "textarea" || /message|comment|question|inquiry|how can we help|notes/.test(key)) value = message;

    if (value === null) {
      if (f.required) return { error: `Required field "${f.label || f.name}" is not supported` };
      continue;
    }
    plan.push({ index, action, value });
  }
  if (!plan.some((p) => p.value === identity.email || p.value === identity.phone)) return { error: "The form has no email or phone field to receive a response on" };
  return { plan };
}

async function finish(interactionId: string, status: "SKIPPED" | "BLOCKED" | "FAILED", detail: string, dealershipId: string): Promise<string> {
  await db().update(testInteractions).set({ status, statusDetail: detail.slice(0, 1000), completedAt: new Date() }).where(eq(testInteractions.id, interactionId));
  await emit(status === "SKIPPED" ? "Form test skipped by policy" : status === "BLOCKED" ? "Form test stopped at an access control" : "Form test could not be completed", { agent: status === "SKIPPED" ? "sentinel" : "charlie", dealershipId, interactionId, detail, status: status === "FAILED" ? "ERROR" : "BLOCKED", kind: status === "FAILED" ? "task.failed" : "task.blocked" });
  await audit("system:interaction", "test.skipped", "interaction", interactionId, { status, detail, dealershipId });
  return `${status}: ${detail}`;
}

/**
 * Submits one approved inquiry form using a configured test identity.
 *
 * Safety properties:
 *  - Only an APPROVED interaction is picked up, and the claim to RUNNING is atomic, so a
 *    duplicate or retried job can never submit twice.
 *  - Eligibility (suppression, cooldown, approval, identity, domain) is re-checked here,
 *    immediately before the browser opens, and again against the form actually found on the page.
 *  - Anything unexpected — CAPTCHA, a required field we don't understand, a validation error —
 *    ends the run without submitting.
 */
export async function runFormInteraction(interactionId: string): Promise<string> {
  const [claimed] = await db()
    .update(testInteractions)
    .set({ status: "RUNNING", startedAt: new Date() })
    .where(and(eq(testInteractions.id, interactionId), eq(testInteractions.status, "APPROVED")))
    .returning();
  if (!claimed) return "SKIPPED: interaction is not in APPROVED state (already handled or cancelled)";
  const dealershipId = claimed.dealershipId;

  if (claimed.testType !== "FORM") return finish(interactionId, "SKIPPED", "Only FORM interactions are automated in V1", dealershipId);
  if (!claimed.message || !(APPROVED_MESSAGES as readonly string[]).includes(claimed.message)) {
    return finish(interactionId, "SKIPPED", "Message is not on the approved list", dealershipId);
  }

  const precheck = await checkEligibility({
    dealershipId,
    identityId: claimed.identityId,
    targetUrl: claimed.sourceUrl,
    formType: claimed.formType,
    form: null,
    excludeInteractionId: interactionId,
  });
  if (!precheck.eligible) return finish(interactionId, "SKIPPED", precheck.reasons.map((r) => r.message).join(" "), dealershipId);

  const [identity] = claimed.identityId ? await db().select().from(testIdentities).where(eq(testIdentities.id, claimed.identityId)).limit(1) : [];
  if (!identity || !claimed.sourceUrl) return finish(interactionId, "SKIPPED", "Identity or form URL missing", dealershipId);

  const crawler = await Crawler.open({ maxPages: 1, present: "visitor" }); // approved test: shown the same widget a customer gets; research suffix stays on
  try {
    await emit("Opening the form page", { interactionId, detail: claimed.sourceUrl });
    const visit = await crawler.visit(claimed.sourceUrl, "CONTACT");
    if (!visit.snapshot) {
      const blocked = visit.page.outcome === "BLOCKED" || visit.page.outcome === "ROBOTS_DISALLOWED";
      return finish(interactionId, blocked ? "BLOCKED" : "FAILED", visit.page.detail ?? "Form page could not be read", dealershipId);
    }

    // Locate the form by type on the live page (document.forms order is preserved by the snapshot).
    const forms = classifyForms(visit.snapshot, "CONTACT");
    const formIndex = forms.findIndex((f) => f.type === claimed.formType);
    const form = forms[formIndex];
    if (!form) return finish(interactionId, "FAILED", `No ${claimed.formType} form found on the page`, dealershipId);

    const recheck = await checkEligibility({
      dealershipId,
      identityId: claimed.identityId,
      targetUrl: visit.snapshot.url,
      formType: form.type,
      form,
      excludeInteractionId: interactionId,
    });
    if (!recheck.eligible) {
      const captcha = recheck.reasons.some((r) => r.code === "CAPTCHA_PRESENT");
      return finish(interactionId, captcha ? "BLOCKED" : "SKIPPED", recheck.reasons.map((r) => r.message).join(" "), dealershipId);
    }
    if (visit.snapshot.hasCaptcha) return finish(interactionId, "BLOCKED", "The page is protected by a CAPTCHA; it will not be bypassed.", dealershipId);

    const planned = planFields(form.fields, identity, claimed.message);
    if ("error" in planned) return finish(interactionId, "FAILED", `${planned.error}. Nothing was submitted.`, dealershipId);

    // Fill only visible fields, addressed by their position among the form's visible controls.
    const formLocator = crawler.page.locator("form").nth(formIndex);
    const controls = formLocator.locator("input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]), select, textarea").filter({ visible: true });
    if ((await controls.count()) !== form.fields.length) {
      return finish(interactionId, "FAILED", "The form changed between detection and filling. Nothing was submitted.", dealershipId);
    }
    for (const step of planned.plan) {
      const control = controls.nth(step.index);
      if (step.action === "fill") await control.fill(step.value);
      else if (step.action === "check") await control.check();
      else {
        const options = await control.locator("option").allTextContents();
        const pick = step.value.split("|").map((want) => options.find((o) => o.toLowerCase().includes(want))).find(Boolean);
        if (pick) await control.selectOption({ label: pick });
      }
    }

    const valid = await formLocator.evaluate((el) => (el as HTMLFormElement).checkValidity());
    if (!valid) return finish(interactionId, "FAILED", "The form's own validation rejected the values. Nothing was submitted.", dealershipId);

    await emit(`Filled the ${form.type.toLowerCase().replace("_", " ")} form with the test identity`, { interactionId, detail: `${planned.plan.length} field(s)` });
    const before = await saveScreenshot({ dealershipId, type: "FORM", body: await crawler.screenshot(), sourceUrl: visit.snapshot.url, interactionId });
    await emit("Screenshot saved before submitting", { interactionId, evidenceId: before.id, status: "DONE" });

    const submit = formLocator.locator("button[type=submit], input[type=submit], button:not([type])").first();
    if ((await submit.count()) === 0) return finish(interactionId, "FAILED", "No submit button found. Nothing was submitted.", dealershipId);

    // The response timer starts at the click, not when the confirmation page finishes loading.
    const submittedAt = new Date();
    await submit.click();
    await emit("Inquiry submitted — response timer started", { interactionId, detail: submittedAt.toISOString(), status: "DONE" });
    await crawler.page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    await crawler.page.waitForTimeout(1_500);
    const afterTitle = await crawler.page.title().catch(() => "");
    const afterText = (await crawler.page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 400);
    await saveScreenshot({ dealershipId, type: "FORM", body: await crawler.screenshot(), sourceUrl: crawler.page.url(), interactionId });

    await db().insert(transcriptMessages).values([
      { interactionId, dealershipId, timestamp: submittedAt, speaker: "RESEARCHER", channel: "OTHER", message: `Submitted ${form.type} form at ${visit.snapshot.url}: "${claimed.message}"` },
      { interactionId, dealershipId, timestamp: new Date(), speaker: "SYSTEM", channel: "OTHER", message: `Page after submit — ${afterTitle || "(no title)"}: ${afterText}` },
    ]);
    await db()
      .update(testInteractions)
      .set({ status: "MONITORING", submittedAt, sourceUrl: visit.snapshot.url, screenshotUrl: before.storageUrl, statusDetail: null })
      .where(eq(testInteractions.id, interactionId));

    const settings = await getSettings();
    const retest = new Date(submittedAt.getTime() + Math.max(30, settings.interactionCooldownDays) * 86_400_000);
    await db().update(dealerships).set({ nextAction: "Wait for response timer", nextActionDue: retest, updatedAt: new Date() }).where(eq(dealerships.id, dealershipId));
    await audit("system:interaction", "test.submitted", "interaction", interactionId, { dealershipId, url: visit.snapshot.url, formType: form.type, identityId: identity.id });

    // First milestone check in 5 minutes; the response-check job reschedules itself after that.
    await enqueue("response-check", { interactionId, dealershipId }, { key: "5m", delayMs: 5 * 60_000 });
    return `SUBMITTED at ${submittedAt.toISOString()}`;
  } catch (err) {
    // If the click already happened the timer must still run; otherwise mark the run failed.
    const [current] = await db().select({ status: testInteractions.status }).from(testInteractions).where(eq(testInteractions.id, interactionId)).limit(1);
    if (current?.status === "RUNNING") await finish(interactionId, "FAILED", `Unexpected error before submission: ${(err as Error).message.split("\n")[0]}`, dealershipId);
    throw err;
  } finally {
    await crawler.close();
  }
}

/** Forms from the latest scan that an operator may pick for a test. */
export async function submittableForms(dealershipId: string) {
  const [obs] = await db()
    .select({ leadForms: websiteObservations.leadForms })
    .from(websiteObservations)
    .where(and(eq(websiteObservations.dealershipId, dealershipId), eq(websiteObservations.websiteStatus, "OK")))
    .orderBy(desc(websiteObservations.timestamp))
    .limit(1);
  return obs?.leadForms ?? [];
}
