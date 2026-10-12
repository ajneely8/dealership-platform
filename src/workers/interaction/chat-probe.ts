import { and, desc, eq } from "drizzle-orm";
import type { Frame, Locator, Page } from "playwright";
import { db } from "@/db";
import { testIdentities, testInteractions, transcriptMessages, websiteObservations, type TestIdentity, responses } from "@/db/schema";
import { APPROVED_MESSAGES } from "@/domain/constants";
import { checkEligibility } from "@/domain/eligibility";
import { pickFollowUp } from "@/domain/chat-followups";
import { gradeChatbot } from "@/domain/chat-grade";
import { recordResponse } from "@/domain/responses";
import { classifyResponseByRule } from "@/domain/response-timing";
import { audit } from "@/lib/audit";
import { saveScreenshot } from "@/lib/evidence";
import { logger } from "@/lib/logger";
import { getSettings } from "@/lib/settings";
import { enqueue } from "@/queue";
import { Crawler } from "../website/crawler";
import { emit } from "@/lib/agent-events";

/**
 * Automated chat test. Opens the dealership's chat widget, sends ONE approved question as the
 * configured test identity, and watches for replies for a short window. It never sends a second
 * message, never negotiates, and never provides anything beyond name / email / phone when the
 * widget insists on contact details before it will talk.
 *
 * Chat widgets differ wildly, so this is best-effort: when it cannot find a launcher or a message
 * box it records that outcome and stops, and the operator can run the chat by hand instead.
 */

const LAUNCHER = /\b(chat|text us|message us|let'?s talk|ask (us|a question)|talk to us|live help)\b/i;
const NOT_LAUNCHER = /facebook|whatsapp|messenger|video|careers|privacy|policy|accessibility/i;
const MESSAGE_BOX = /message|type|chat|ask|question|how can|say something|reply/i;
const CONTACT_FIELD: { key: "name" | "email" | "phone"; re: RegExp }[] = [
  { key: "email", re: /e-?mail/i },
  { key: "phone", re: /phone|mobile|cell|\btel\b|number/i },
  { key: "name", re: /name/i },
];
/** Lines a widget prints that are not a reply from the dealership. */
const CHROME_TEXT = /^(send|close|minimize|powered by|type (a |your )?message|start chat|new conversation|online|offline|\d{1,2}:\d{2}( ?[ap]m)?)$/i;

const WAIT_FOR_REPLY_SECONDS = 90;
const GRACE_AFTER_REPLY_SECONDS = 20;
/** How long to wait for an answer to a follow-up before closing the conversation. */
const FOLLOWUP_WAIT_SECONDS = 45;

/** Grades the chatbot from what the test saw and writes it onto the latest website observation. */
async function recordGrade(dealershipId: string, input: Parameters<typeof gradeChatbot>[0], interactionId: string): Promise<void> {
  const g = gradeChatbot(input);
  const [obs] = await db().select({ id: websiteObservations.id }).from(websiteObservations).where(eq(websiteObservations.dealershipId, dealershipId)).orderBy(desc(websiteObservations.timestamp)).limit(1);
  if (obs) await db().update(websiteObservations).set({ chatGrade: g.grade, chatQuality: g.score }).where(eq(websiteObservations.id, obs.id));
  await emit(`Chatbot graded: ${g.grade === "GOOD" ? "good" : g.grade === "BAD" ? "bad" : "none"} (${g.score}/100)`, { interactionId, dealershipId, detail: g.reasons.join("; "), status: g.grade === "BAD" ? "BLOCKED" : "DONE", kind: "finding.created" });
}

async function finish(interactionId: string, dealershipId: string, status: "SKIPPED" | "BLOCKED" | "FAILED", detail: string): Promise<string> {
  await db().update(testInteractions).set({ status, statusDetail: detail.slice(0, 1000), completedAt: new Date() }).where(eq(testInteractions.id, interactionId));
  await audit("system:chat-probe", "test.skipped", "interaction", interactionId, { status, detail, dealershipId });
  await emit(status === "SKIPPED" ? "Chat test skipped by policy" : status === "BLOCKED" ? "Chat test stopped at an access control" : "Chat test could not be completed", { agent: status === "SKIPPED" ? "sentinel" : "charlie", dealershipId, interactionId, detail, status: status === "FAILED" ? "ERROR" : "BLOCKED", kind: status === "FAILED" ? "task.failed" : "task.blocked" });
  return `${status}: ${detail}`;
}

/**
 * First visible element matching the selector (and, when given, whose text matches hasText —
 * applied in the browser so a launcher injected after hundreds of nav links is still reached).
 */
async function firstVisible(scope: Page | Frame, selector: string, filter?: (text: string) => boolean, hasText?: RegExp): Promise<Locator | null> {
  let candidates = scope.locator(selector);
  if (hasText) candidates = candidates.filter({ hasText });
  candidates = candidates.filter({ visible: true });
  const n = Math.min(await candidates.count().catch(() => 0), 80);
  for (let i = 0; i < n; i++) {
    const loc = candidates.nth(i);
    if (!filter) return loc;
    const text = [await loc.innerText().catch(() => ""), await loc.getAttribute("aria-label").catch(() => ""), await loc.getAttribute("title").catch(() => ""), await loc.getAttribute("placeholder").catch(() => "")]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (filter(text)) return loc;
  }
  return null;
}

const DEPARTMENT_PREFERENCE = [/new.*sales?|sales?.*new/i, /^sales?$|sales?/i, /pre-?owned|used/i, /internet|general|other|question/i];
const NOT_A_DEPARTMENT = /cancel|close|back|no thanks|parts|service|finance|collision|body shop|careers|x$/i;

/**
 * Some widgets route the visitor to a department before they show a message box
 * ("New Car Sales / Pre-Owned Sales / Parts / Service"). Picking a sales department is routing,
 * not a message, and keeps the test on the lead-handling path the question is about. Parts and
 * service are never chosen; if nothing sales-like is offered, nothing is clicked.
 */
async function findDepartmentChoice(page: Page): Promise<{ loc: Locator; label: string } | null> {
  for (const scope of scopes(page)) {
    const candidates = scope.locator("button, [role=button], a, li[onclick], div[onclick]").filter({ visible: true });
    const n = Math.min(await candidates.count().catch(() => 0), 30);
    const options: { loc: Locator; label: string }[] = [];
    for (let i = 0; i < n; i++) {
      const loc = candidates.nth(i);
      const label = (await loc.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      if (!label || label.length > 30 || LAUNCHER.test(label) || NOT_A_DEPARTMENT.test(label)) continue;
      options.push({ loc, label });
    }
    for (const re of DEPARTMENT_PREFERENCE) {
      const hit = options.find((o) => re.test(o.label));
      if (hit) return hit;
    }
  }
  return null;
}

/** Main page first, then every iframe (vendor widgets almost always live in one). */
function scopes(page: Page): (Page | Frame)[] {
  return [page, ...page.frames().filter((f) => f !== page.mainFrame())];
}

/** For screening: does a chat launcher appear within `ms`? Returns its label, or null. Nothing is clicked. */
export async function chatLauncherVisible(page: Page, ms = 12_000): Promise<string | null> {
  const until = Date.now() + ms;
  for (;;) {
    const hit = await findLauncher(page);
    if (hit) return (await hit.innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 40) || "chat";
    if (Date.now() >= until) return null;
    await page.waitForTimeout(1500);
  }
}

async function findLauncher(page: Page): Promise<Locator | null> {
  for (const scope of scopes(page)) {
    const hit = await firstVisible(scope, "button, a, [role=button], div[onclick], div[tabindex]", (t) => t.length <= 60 && LAUNCHER.test(t) && !NOT_LAUNCHER.test(t), LAUNCHER);
    if (hit) return hit;
    // Icon-only launchers: the words live in aria-label / title rather than text.
    const labelled = await firstVisible(scope, "button[aria-label], a[aria-label], [role=button][aria-label], button[title], a[title]", (t) => t.length <= 60 && LAUNCHER.test(t) && !NOT_LAUNCHER.test(t));
    if (labelled) return labelled;
  }
  return null;
}

const BOX_SELECTOR = "textarea, input[type=text], input:not([type]), [contenteditable=true], [role=textbox]";
const NOT_A_CHAT_BOX = /search|keyword|zip|postal|\bq\b|stock|vin|price|mileage|year|make|model|email|phone|coupon|promo|subscribe|newsletter/i;

/** A stable description of every visible text box, so boxes that existed before the widget opened can be excluded. */
async function boxSignatures(page: Page): Promise<Set<string>> {
  const out = new Set<string>();
  for (const scope of scopes(page)) {
    const sigs = await scope
      .locator(BOX_SELECTOR)
      .evaluateAll((els) =>
        els
          .filter((e) => {
            const r = (e as HTMLElement).getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })
          .map((e) => [e.tagName, e.getAttribute("placeholder"), e.getAttribute("name"), e.id, e.getAttribute("aria-label")].join("|")),
      )
      .catch(() => [] as string[]);
    for (const sig of sigs) out.add(`${scope.url()}#${sig}`);
  }
  return out;
}

async function boxSignature(scope: Page | Frame, loc: Locator): Promise<string> {
  const sig = await loc.evaluate((e) => [e.tagName, e.getAttribute("placeholder"), e.getAttribute("name"), e.id, e.getAttribute("aria-label")].join("|")).catch(() => "");
  return `${scope.url()}#${sig}`;
}

/**
 * The widget's message box. Only boxes that were NOT visible before the launcher was clicked
 * qualify (a box that was always there is the site's own search or lead form), and nothing
 * that looks like a search, filter or lead-form field is ever used.
 */
async function findMessageBox(page: Page, seenBefore: Set<string> = new Set()): Promise<{ box: Locator; scope: Page | Frame } | null> {
  const passes: [string, ((t: string) => boolean) | undefined][] = [
    [BOX_SELECTOR, (t) => MESSAGE_BOX.test(t) && !NOT_A_CHAT_BOX.test(t)],
    ["textarea, [contenteditable=true], [role=textbox]", (t) => !NOT_A_CHAT_BOX.test(t)],
  ];
  for (const [selector, filter] of passes) {
    for (const scope of scopes(page)) {
      const candidates = scope.locator(selector).filter({ visible: true });
      const n = Math.min(await candidates.count().catch(() => 0), 40);
      for (let i = 0; i < n; i++) {
        const loc = candidates.nth(i);
        const text = [await loc.getAttribute("placeholder").catch(() => ""), await loc.getAttribute("aria-label").catch(() => ""), await loc.getAttribute("name").catch(() => ""), await loc.getAttribute("id").catch(() => "")].filter(Boolean).join(" ");
        if ((await loc.getAttribute("type").catch(() => "")) === "search") continue;
        if (filter && !filter(text)) continue;
        if (seenBefore.has(await boxSignature(scope, loc))) continue;
        return { box: loc, scope };
      }
    }
  }
  return null;
}

/**
 * Some widgets want a name / phone / email before they talk. Fill those three from the identity
 * and nothing else; a required field we don't recognise ends the test.
 */
async function passContactGate(page: Page, identity: Pick<TestIdentity, "name" | "email" | "phone">): Promise<"filled" | "none" | "unsupported"> {
  for (const scope of scopes(page)) {
    const inputs = scope.locator("input[type=text], input[type=email], input[type=tel], input:not([type])").filter({ visible: true });
    const n = Math.min(await inputs.count().catch(() => 0), 8);
    if (n === 0) continue;
    const plan: { loc: Locator; value: string }[] = [];
    let unsupported = false;
    for (let i = 0; i < n; i++) {
      const loc = inputs.nth(i);
      const label = [await loc.getAttribute("name"), await loc.getAttribute("placeholder"), await loc.getAttribute("aria-label"), await loc.getAttribute("id")].filter(Boolean).join(" ");
      const type = (await loc.getAttribute("type")) ?? "";
      const match = CONTACT_FIELD.find((c) => c.re.test(label) || (c.key === "email" && type === "email") || (c.key === "phone" && type === "tel"));
      if (match) plan.push({ loc, value: identity[match.key] });
      else if ((await loc.getAttribute("required")) !== null) unsupported = true;
    }
    if (plan.length === 0) continue;
    if (unsupported) return "unsupported";
    for (const p of plan) await p.loc.fill(p.value);
    const consent = scope.locator("input[type=checkbox][required]").filter({ visible: true }).first();
    if ((await consent.count()) > 0) await consent.check().catch(() => undefined);
    const go = await firstVisible(scope, "button, input[type=submit], [role=button]", (t) => /start|begin|continue|submit|send|next|chat/i.test(t));
    if (go) await go.click().catch(() => undefined);
    else await plan[plan.length - 1]!.loc.press("Enter").catch(() => undefined);
    await page.waitForTimeout(2000);
    return "filled";
  }
  return "none";
}

function visibleLines(text: string): string[] {
  return text
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length >= 2 && l.length <= 600 && !CHROME_TEXT.test(l));
}

export async function runChatProbe(interactionId: string): Promise<string> {
  const [claimed] = await db()
    .update(testInteractions)
    .set({ status: "RUNNING", startedAt: new Date() })
    .where(and(eq(testInteractions.id, interactionId), eq(testInteractions.status, "APPROVED")))
    .returning();
  if (!claimed) return "SKIPPED: interaction is not in APPROVED state (already handled or cancelled)";
  const dealershipId = claimed.dealershipId;
  if (claimed.testType !== "CHAT") return finish(interactionId, dealershipId, "SKIPPED", "Not a chat test");
  if (!claimed.message || !(APPROVED_MESSAGES as readonly string[]).includes(claimed.message)) return finish(interactionId, dealershipId, "SKIPPED", "Message is not on the approved list");

  const eligibility = await checkEligibility({ dealershipId, identityId: claimed.identityId, targetUrl: claimed.sourceUrl, testType: "CHAT", formType: null, form: null, excludeInteractionId: interactionId });
  if (!eligibility.eligible) return finish(interactionId, dealershipId, "SKIPPED", eligibility.reasons.map((r) => r.message).join(" "));
  const [identity] = claimed.identityId ? await db().select().from(testIdentities).where(eq(testIdentities.id, claimed.identityId)).limit(1) : [];
  if (!identity || !claimed.sourceUrl) return finish(interactionId, dealershipId, "SKIPPED", "Identity or page URL missing");
  const settings = await getSettings();

  const crawler = await Crawler.open({ maxPages: 1, present: "visitor" }); // approved test: shown the same widget a customer gets; research suffix stays on
  const page = crawler.page;
  const note = async (message: string) =>
    db().insert(transcriptMessages).values({ interactionId, dealershipId, timestamp: new Date(), speaker: "SYSTEM", channel: "CHAT", message });
  try {
    const visit = await crawler.visit(claimed.sourceUrl, "HOMEPAGE");
    if (!visit.snapshot) {
      const blocked = visit.page.outcome === "BLOCKED" || visit.page.outcome === "ROBOTS_DISALLOWED";
      return finish(interactionId, dealershipId, blocked ? "BLOCKED" : "FAILED", visit.page.detail ?? "Page could not be read");
    }
    if (visit.snapshot.hasCaptcha) return finish(interactionId, dealershipId, "BLOCKED", "The page is protected by a CAPTCHA; it will not be bypassed.");

    // Widgets load late (vendor scripts, then their iframe); keep looking for up to ~15 s.
    let launcher: Locator | null = null;
    for (let attempt = 0; attempt < 9 && !launcher; attempt++) {
      await page.waitForTimeout(attempt === 0 ? 3000 : 1500);
      launcher = await findLauncher(page);
    }
    if (!launcher) {
      await saveScreenshot({ dealershipId, type: "CHAT", body: await crawler.screenshot(), sourceUrl: page.url(), interactionId });
      await recordGrade(dealershipId, { chatPresent: true, launcherFound: false, boxFound: false, replies: [], humanReplies: 0, answered: false, contactRequired: false, firstResponseSeconds: null }, interactionId);
      return finish(interactionId, dealershipId, "FAILED", "No chat launcher found on the page. Run the chat by hand and log it.");
    }
    await emit("Chat launcher found, opening the widget", { interactionId });
    const boxesBefore = await boxSignatures(page);
    await launcher.click({ timeout: 10_000 });
    await page.waitForTimeout(2500);

    let box = await findMessageBox(page, boxesBefore);
    let contactRequired = false;
    // Up to three preliminary screens: a contact gate, a department menu, or both, in any order.
    for (let step = 0; !box && step < 3; step++) {
      const gate = await passContactGate(page, identity);
      if (gate === "unsupported") return finish(interactionId, dealershipId, "FAILED", "The chat asked for details beyond name, email and phone before starting. Nothing was sent.");
      if (gate === "filled") {
        contactRequired = true;
        await note("Chat asked for contact details before starting; name, email and phone from the test identity were provided.");
        await emit("Chat asked for contact details first; identity's name, email and phone given", { interactionId });
        await page.waitForTimeout(2000);
        box = await findMessageBox(page, boxesBefore);
        continue;
      }
      const choice = await findDepartmentChoice(page);
      if (!choice) break;
      await note(`Chat asked for a department first; "${choice.label}" was chosen.`);
      await emit(`Chat asked for a department; chose "${choice.label}"`, { interactionId });
      await saveScreenshot({ dealershipId, type: "CHAT", body: await crawler.screenshot(), sourceUrl: page.url(), interactionId });
      await choice.loc.click({ timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(2500);
      box = await findMessageBox(page, boxesBefore);
    }
    if (!box) {
      await saveScreenshot({ dealershipId, type: "CHAT", body: await crawler.screenshot(), sourceUrl: page.url(), interactionId });
      await recordGrade(dealershipId, { chatPresent: true, launcherFound: true, boxFound: false, replies: [], humanReplies: 0, answered: false, contactRequired, firstResponseSeconds: null }, interactionId);
      return finish(interactionId, dealershipId, "FAILED", "Chat opened but no message box belonging to the widget was found. Run the chat by hand and log it.");
    }

    // Replies are read from the widget itself: the iframe body when the widget is an iframe, or
    // the smallest panel around the message box on the page (never the whole page).
    const chatScope = box.scope;
    const panel =
      chatScope === page
        ? await box.box.evaluateHandle((el: Element) => {
            let n: Element = el;
            while (n.parentElement) {
              const r = n.parentElement.getBoundingClientRect();
              if (r.height > window.innerHeight * 0.9 || r.width > window.innerWidth * 0.75) break;
              n = n.parentElement;
            }
            return n;
          }).catch(() => null)
        : null;
    const textOf = () => (panel ? panel.evaluate((el: Element) => (el as HTMLElement).innerText ?? "").catch(() => "") : chatScope.locator("body").innerText({ timeout: 5000 }).catch(() => ""));
    let isolated = true;
    const before = new Set(visibleLines(await textOf()));

    await box.box.fill(claimed.message);
    await saveScreenshot({ dealershipId, type: "CHAT", body: await crawler.screenshot(), sourceUrl: page.url(), interactionId });
    const submittedAt = new Date();
    await box.box.press("Enter");
    await page.waitForTimeout(800);
    // If Enter only added a newline, use the send button.
    const leftover = await box.box.inputValue().catch(async () => (await box!.box.innerText().catch(() => "")) ?? "");
    if (leftover.trim() === claimed.message) {
      const send = await firstVisible(chatScope, "button, [role=button]", (t) => /send|submit/i.test(t) || t === "");
      if (send) await send.click().catch(() => undefined);
    }
    await db().insert(transcriptMessages).values({ interactionId, dealershipId, timestamp: submittedAt, speaker: "RESEARCHER", channel: "CHAT", message: claimed.message });
    await emit(`Asked: "${claimed.message}"`, { interactionId, status: "DONE" });
    await db().update(testInteractions).set({ status: "MONITORING", submittedAt, sourceUrl: page.url() }).where(eq(testInteractions.id, interactionId));
    await audit("system:chat-probe", "test.submitted", "interaction", interactionId, { dealershipId, url: page.url(), identityId: identity.id });
    before.add(claimed.message);

    // Listen for replies, then keep the conversation going within the limits: at most
    // settings.maxChatMessages messages from us, each from the approved list, and no more messages
    // once a person has joined (settings.maxHumanReplies) — a person's time is not for testing.
    const seen = new Set(before);
    const replies: string[] = [];
    let humanReplies = 0;
    let sent = 1;
    let ourLast: string = claimed.message ?? "";
    const listen = async (seconds: number): Promise<string[]> => {
      const fresh: string[] = [];
      const deadline = Date.now() + seconds * 1000;
      let stopAt = deadline;
      while (Date.now() < stopAt) {
        await page.waitForTimeout(3000);
        await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);
        const lines = visibleLines(await textOf());
        const unseen = lines.filter((x) => !seen.has(x) && /[a-z]{2}/i.test(x) && !/^\$?[\d,.]+ ?(mi|miles|k|l)?$/i.test(x));
        if (unseen.length > 12) {
          // Dozens of new lines at once is page content moving, not a conversation.
          isolated = false;
          await emit("Too much text changed at once; replies could not be isolated from page content", { interactionId, detail: `${unseen.length} lines`, status: "BLOCKED" });
          for (const x of unseen) seen.add(x);
          return fresh;
        }
        for (const l of unseen) {
          seen.add(l);
          // Widgets echo the visitor's message back, often with a "You:" prefix; that is not a reply.
          if ((ourLast && l.includes(ourLast)) || (claimed.message && l.includes(claimed.message))) continue;
          fresh.push(l);
          replies.push(l);
          const seconds = Math.round((Date.now() - submittedAt.getTime()) / 1000);
          const cls = classifyResponseByRule({ channel: "CHAT", message: l, sender: "chat widget", responseSeconds: seconds });
          if (cls.humanOrAutomation === "HUMAN") humanReplies += 1;
          await recordResponse({ interactionId, channel: "CHAT", receivedAt: new Date(), sender: "chat widget", message: l, ingestedVia: "PROBE", externalId: null, actor: "system:chat-probe" });
          await emit(`Reply: "${l.slice(0, 160)}"`, { interactionId, detail: `${seconds}s after the question · ${cls.humanOrAutomation.toLowerCase()}`, status: "DONE", kind: "response.received" });
          stopAt = Math.min(deadline, Date.now() + GRACE_AFTER_REPLY_SECONDS * 1000);
        }
        // A widget that demands contact details after the question is noted and answered once.
        if (!contactRequired && replies.length === 0 && (await passContactGate(page, identity)) === "filled") {
          contactRequired = true;
          await note("Chat asked for contact details after the question; name, email and phone from the test identity were provided.");
        }
      }
      return fresh;
    };

    let fresh = await listen(WAIT_FOR_REPLY_SECONDS);
    while (fresh.length > 0 && isolated) {
      if (humanReplies > 0 && humanReplies >= settings.maxHumanReplies) {
        await note("A person joined the chat; no further messages were sent so as not to take up their time.");
        await emit("A person joined the chat — conversation ended on our side", { interactionId, status: "DONE" });
        break;
      }
      const next = pickFollowUp(fresh[fresh.length - 1]!, sent, settings.maxChatMessages);
      if (next.kind === "stop") {
        await emit(`Conversation closed: ${next.why}`, { interactionId });
        break;
      }
      if (next.kind === "wait") {
        await emit(`Waiting: ${next.why}`, { interactionId });
        fresh = await listen(FOLLOWUP_WAIT_SECONDS);
        if (fresh.length === 0) break;
        continue;
      }
      const again = await findMessageBox(page, boxesBefore);
      if (!again) {
        await emit("The message box disappeared; conversation ended", { interactionId });
        break;
      }
      await again.box.fill(next.text);
      await again.box.press("Enter");
      await page.waitForTimeout(800);
      const left = await again.box.inputValue().catch(async () => (await again.box.innerText().catch(() => "")) ?? "");
      if (left.trim() === next.text) {
        const send = await firstVisible(again.scope, "button, [role=button]", (t) => /send|submit/i.test(t) || t === "");
        if (send) await send.click().catch(() => undefined);
      }
      sent += 1;
      ourLast = next.text;
      seen.add(next.text);
      await db().insert(transcriptMessages).values({ interactionId, dealershipId, timestamp: new Date(), speaker: "RESEARCHER", channel: "CHAT", message: next.text });
      await emit(`Said: "${next.text}"`, { interactionId, detail: `follow-up ${sent} of ${settings.maxChatMessages} · ${next.why}`, status: "DONE" });
      await saveScreenshot({ dealershipId, type: "CHAT", body: await crawler.screenshot(), sourceUrl: page.url(), interactionId });
      fresh = await listen(FOLLOWUP_WAIT_SECONDS);
    }
    await saveScreenshot({ dealershipId, type: "CHAT", body: await crawler.screenshot(), sourceUrl: page.url(), interactionId });

    // A reply that only asks for contact details is a gate, not an answer.
    const answered = replies.some((r) => !/\b(name|email|phone|number)\b.*\?/i.test(r) || r.length > 120);
    const [obs] = await db().select({ id: websiteObservations.id }).from(websiteObservations).where(eq(websiteObservations.dealershipId, dealershipId)).orderBy(desc(websiteObservations.timestamp)).limit(1);
    if (obs) await db().update(websiteObservations).set({ chatWorking: replies.length > 0, contactRequired }).where(eq(websiteObservations.id, obs.id));
    const firstReplySeconds = replies.length ? Math.round(((await db().select({ at: responses.receivedAt }).from(responses).where(eq(responses.interactionId, interactionId)).orderBy(responses.receivedAt).limit(1))[0]?.at.getTime() ?? Date.now()) - submittedAt.getTime()) / 1000 : null;
    await recordGrade(dealershipId, { chatPresent: true, launcherFound: true, boxFound: true, replies, humanReplies, answered, contactRequired, firstResponseSeconds: firstReplySeconds }, interactionId);
    await db()
      .update(testInteractions)
      .set({
        status: "COMPLETED",
        completedAt: new Date(),
        statusDetail: replies.length ? `${replies.length} chat repl${replies.length === 1 ? "y" : "ies"}, ${sent} message${sent === 1 ? "" : "s"} sent${humanReplies ? ` · a person joined` : " · automated only"}${answered ? "" : " (contact details requested, question not answered)"}${isolated ? "" : " · ended early: page content could not be told apart from replies"}` : `No chat reply within ${WAIT_FOR_REPLY_SECONDS}s`,
      })
      .where(eq(testInteractions.id, interactionId));
    await enqueue("scoring", { dealershipId });
    return replies.length ? `COMPLETED: ${replies.length} reply(ies)` : "COMPLETED: no reply";
  } catch (err) {
    const message = (err as Error).message.split("\n")[0] ?? "Unexpected error";
    logger.warn({ interactionId, err: message }, "chat probe failed");
    const [current] = await db().select({ status: testInteractions.status }).from(testInteractions).where(eq(testInteractions.id, interactionId)).limit(1);
    if (current?.status === "RUNNING") return finish(interactionId, dealershipId, "FAILED", `Chat probe error before the question was sent: ${message}`);
    // The question went out: keep what was captured and close the test.
    await db().update(testInteractions).set({ status: "COMPLETED", completedAt: new Date(), statusDetail: `Ended early: ${message}` }).where(eq(testInteractions.id, interactionId));
    await enqueue("scoring", { dealershipId });
    return `COMPLETED (ended early): ${message}`;
  } finally {
    await crawler.close();
  }
}
