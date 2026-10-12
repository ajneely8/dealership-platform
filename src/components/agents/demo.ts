import { AGENT_KEYS, type AgentKey } from "@/domain/agents";
import type { AgentSnapshot, FeedEvent, SceneData } from "./types";

/**
 * DEMO MODE — a scripted, clearly labelled walk-through of the interface.
 *
 * Nothing here touches the backend. Every event carries `demo: true`, the dealership is a
 * fictional "[Demo] Example Motors", and the banner on screen says so. It exists so the
 * interface can be shown before a live research run is available to watch.
 */

const DEMO_DEALER = { id: "demo-dealership", name: "[Demo] Example Motors" };

type Step = { t: number; agent: AgentKey; kind: FeedEvent["kind"]; step: string; detail?: string; status?: string; evidence?: boolean };

// Timings in seconds from the start of the loop. Based on the real event sequence a research
// pass produces, compressed to about two minutes.
const SCRIPT: Step[] = [
  { t: 1, agent: "orion", kind: "task.created", step: "website-scan requested by demo@sarvx", status: "INFO" },
  { t: 2, agent: "nova", kind: "task.started", step: "website-scan started", detail: "requested by an operator" },
  { t: 4, agent: "nova", kind: "task.step.completed", step: "Opened the homepage", detail: "https://example-motors.demo/" },
  { t: 6, agent: "nova", kind: "evidence.saved", step: "Screenshot captured: homepage", status: "DONE", evidence: true },
  { t: 8, agent: "nova", kind: "finding.created", step: "No chat widget found", status: "INFO" },
  { t: 10, agent: "nova", kind: "finding.created", step: "Lead forms found: 1", detail: "CONTACT (4 fields)", status: "DONE" },
  { t: 12, agent: "nova", kind: "task.step.completed", step: "Opened the inventory page", detail: "https://example-motors.demo/inventory" },
  { t: 14, agent: "nova", kind: "finding.created", step: "Inventory counted: 212 vehicles", status: "DONE" },
  { t: 16, agent: "nova", kind: "task.step.completed", step: "Opened the service page", detail: "https://example-motors.demo/service" },
  { t: 18, agent: "nova", kind: "finding.created", step: "Service checked: request form only", status: "DONE" },
  { t: 20, agent: "nova", kind: "task.step.completed", step: "Mobile experience checked: fits a phone screen", status: "DONE" },
  { t: 22, agent: "nova", kind: "finding.created", step: "Findings saved", detail: "2 social profile(s), 1 hiring signal(s)", status: "DONE" },
  { t: 23, agent: "nova", kind: "task.completed", step: "website-scan finished in 21s", status: "DONE" },
  { t: 25, agent: "hunter", kind: "task.started", step: "signals started" },
  { t: 28, agent: "hunter", kind: "finding.created", step: "Growth roles found: Internet Sales Manager, BDC Representative", detail: "https://example-motors.demo/careers", status: "DONE" },
  { t: 29, agent: "hunter", kind: "task.completed", step: "signals finished in 4s", status: "DONE" },
  { t: 31, agent: "sage", kind: "task.started", step: "social started" },
  { t: 33, agent: "sage", kind: "task.step.completed", step: "Reading INSTAGRAM profile", detail: "https://instagram.com/example-motors" },
  { t: 35, agent: "sage", kind: "finding.created", step: "INSTAGRAM: 1,240 followers · 310 posts", status: "DONE" },
  { t: 37, agent: "sage", kind: "finding.created", step: "FACEBOOK: robots.txt disallows automated reading; recorded as not checked", status: "BLOCKED" },
  { t: 38, agent: "sage", kind: "task.completed", step: "social finished in 7s", status: "DONE" },
  { t: 40, agent: "atlas", kind: "task.started", step: "scoring started" },
  { t: 43, agent: "atlas", kind: "finding.created", step: "Scored: summarybot 70, inventory outreach 45, service bot 36, social automation 20 · priority 61", detail: "Recommended summarybot; 6 rule(s) fired", status: "DONE" },
  { t: 44, agent: "atlas", kind: "task.completed", step: "scoring finished in 1s", status: "DONE" },
  { t: 46, agent: "blaze", kind: "task.started", step: "sales-intel started" },
  { t: 48, agent: "blaze", kind: "task.step.completed", step: "Writing brief: 5 evidence claim(s), recommended summarybot" },
  { t: 51, agent: "blaze", kind: "finding.created", step: "Brief ready (template angle)", detail: "No chat or instant reply on the website; a contact form is the only way in", status: "DONE" },
  { t: 52, agent: "blaze", kind: "task.completed", step: "sales-intel finished in 6s", status: "DONE" },
  { t: 55, agent: "orion", kind: "task.created", step: "Form test approved and handed to Charlie", detail: "by demo@sarvx", status: "DONE" },
  { t: 57, agent: "charlie", kind: "task.started", step: "interaction started", detail: "requested by an operator" },
  { t: 59, agent: "charlie", kind: "task.step.completed", step: "Opening the form page", detail: "https://example-motors.demo/contact" },
  { t: 62, agent: "charlie", kind: "task.step.completed", step: "Filled the contact form with the test identity", detail: "4 field(s)" },
  { t: 64, agent: "charlie", kind: "evidence.saved", step: "Screenshot saved before submitting", status: "DONE", evidence: true },
  { t: 66, agent: "charlie", kind: "task.step.completed", step: "Inquiry submitted — response timer started", status: "DONE" },
  { t: 67, agent: "charlie", kind: "task.completed", step: "interaction finished in 10s", status: "DONE" },
  { t: 69, agent: "echo", kind: "task.started", step: "response-check started" },
  { t: 70, agent: "echo", kind: "task.step.completed", step: "Checked: no reply yet" },
  { t: 71, agent: "echo", kind: "task.completed", step: "response-check finished in 1s", status: "DONE" },
  { t: 84, agent: "echo", kind: "response.received", step: "Email received 1,080s after submission", detail: "automated acknowledgement · automation · via webhook", status: "DONE" },
  { t: 92, agent: "orion", kind: "task.blocked", step: "Form test request refused", detail: "A form test was sent to this dealership 0 days ago; the cooldown is 30 days", status: "BLOCKED" },
  { t: 100, agent: "orion", kind: "task.created", step: "Scheduled 3 job(s)", detail: "inventory ×2, social ×1", status: "DONE" },
  { t: 104, agent: "nova", kind: "task.started", step: "inventory started", detail: "scheduled" },
  { t: 108, agent: "nova", kind: "finding.created", step: "Inventory counted: 214 vehicles", status: "DONE" },
  { t: 109, agent: "nova", kind: "task.completed", step: "inventory finished in 5s", status: "DONE" },
  { t: 112, agent: "nova", kind: "task.failed", step: "website-scan failed", detail: "net::ERR_NAME_NOT_RESOLVED at https://second-example.demo/", status: "ERROR" },
];
const LOOP_SECONDS = 120;

export function runDemo(opts: { onState: (agents: AgentSnapshot[]) => void; onEvent: (e: FeedEvent) => void; focus?: AgentKey }): () => void {
  const started = Date.now();
  let loop = 0;
  let index = 0;
  const running = new Map<AgentKey, { jobRunId: string; queue: string; startedAt: string; lastStep: string | null }>();
  const lastDone = new Map<AgentKey, { at: number; ok: boolean }>();
  let awaiting = 0;

  const snapshot = (): AgentSnapshot[] =>
    AGENT_KEYS.map((key) => {
      const cur = running.get(key);
      const done = lastDone.get(key);
      const recent = done && Date.now() - done.at < 20_000;
      const status = cur ? "WORKING" : key === "echo" && awaiting ? "WAITING" : recent ? (done.ok ? "COMPLETED" : "ERROR") : "IDLE";
      return { key, status, waiting: key === "echo" ? awaiting : 0, queued: 0, current: cur ? { ...cur, dealershipId: DEMO_DEALER.id, dealershipName: DEMO_DEALER.name } : null };
    });

  const timer = setInterval(() => {
    const elapsed = (Date.now() - started) / 1000 - loop * LOOP_SECONDS;
    while (index < SCRIPT.length && SCRIPT[index]!.t <= elapsed) {
      const s = SCRIPT[index++]!;
      const at = new Date().toISOString();
      const queue = s.step.split(" ")[0] ?? "task";
      if (s.kind === "task.started") running.set(s.agent, { jobRunId: `demo-${loop}-${index}`, queue, startedAt: at, lastStep: null });
      else if (running.has(s.agent)) running.get(s.agent)!.lastStep = s.step;
      if (s.kind === "task.completed" || s.kind === "task.failed" || s.kind === "task.blocked") {
        if (running.has(s.agent)) {
          running.delete(s.agent);
          lastDone.set(s.agent, { at: Date.now(), ok: s.kind === "task.completed" });
        }
      }
      if (s.step.startsWith("Inquiry submitted")) awaiting = 1;
      if (s.kind === "response.received") awaiting = 0;
      opts.onEvent({
        id: `demo-${loop}-${index}`,
        at,
        agent: s.agent,
        kind: s.kind,
        step: s.step,
        detail: s.detail ?? null,
        status: s.status ?? "INFO",
        dealershipId: DEMO_DEALER.id,
        dealershipName: DEMO_DEALER.name,
        interactionId: null,
        evidenceId: s.evidence ? "demo" : null,
        jobRunId: running.get(s.agent)?.jobRunId ?? null,
        demo: true,
      });
    }
    if (index >= SCRIPT.length && elapsed > LOOP_SECONDS) {
      loop += 1;
      index = 0;
      awaiting = 0;
    }
    opts.onState(snapshot());
  }, 500);
  return () => clearInterval(timer);
}

/** Scene facts for demo mode. Fictional, and labelled as such on screen. */
export function demoSceneData(key: AgentKey): SceneData {
  const now = new Date().toISOString();
  switch (key) {
    case "nova":
      return { kind: "nova", site: { dealershipName: DEMO_DEALER.name, url: "https://example-motors.demo", chatVendor: null, chatPresent: false, leadFormCount: 1, inventoryCount: 212, serviceMode: "FORM_ONLY", mobileFriendly: true, websiteStatus: "OK", scannedAt: now } };
    case "charlie":
      return {
        kind: "charlie",
        recent: [],
        test: { id: "demo-test", dealershipName: DEMO_DEALER.name, testType: "CHAT", status: "COMPLETED", submittedAt: now, firstResponseSeconds: 84 },
        transcript: [
          { speaker: "RESEARCHER", message: "Hi, is the 2024 F-150 you have listed still available?", at: now },
          { speaker: "DEALERSHIP", message: "Thanks for reaching out! Someone from our team will be with you shortly.", at: now },
          { speaker: "DEALERSHIP", message: "Can I get your name and phone number so a salesperson can call you?", at: now },
        ],
      };
    case "sage":
      return {
        kind: "sage",
        cards: [
          { id: "d1", dealershipName: DEMO_DEALER.name, platform: "INSTAGRAM", followers: 1240, posts: 310, questions: 4, unanswered: 3, note: "Three pricing questions in comments with no reply", at: now },
          { id: "d2", dealershipName: DEMO_DEALER.name, platform: "FACEBOOK", followers: null, posts: null, questions: null, unanswered: null, note: "Not readable without signing in; recorded as not checked", at: now },
          { id: "d3", dealershipName: DEMO_DEALER.name, platform: "YOUTUBE", followers: 86, posts: 12, questions: 0, unanswered: 0, note: "Walkaround videos, no questions", at: now },
        ],
      };
    case "hunter":
      return { kind: "hunter", signals: [{ id: "s1", dealershipName: DEMO_DEALER.name, title: "Internet Sales Manager", type: "INTERNET_SALES", at: now }, { id: "s2", dealershipName: DEMO_DEALER.name, title: "BDC Representative", type: "BDC", at: now }, { id: "s3", dealershipName: DEMO_DEALER.name, title: "Service Advisor", type: "SERVICE", at: now }] };
    case "atlas":
      return { kind: "atlas", target: { dealershipName: DEMO_DEALER.name, priority: 61, recommended: "SUMMARYBOT", scores: [{ product: "SUMMARYBOT", score: 70 }, { product: "INVENTORY_OUTREACH", score: 45 }, { product: "SERVICE_BOT", score: 36 }, { product: "SOCIAL_AUTOMATION", score: 20 }], observed: 7, inferred: 2 } };
    case "blaze":
      return {
        kind: "blaze",
        brief: { dealershipName: DEMO_DEALER.name, priority: 61, product: "SUMMARYBOT", mainProblem: "No chat or instant reply on the website; a contact form is the only way in", salesAngle: "Leads that land on the site after hours have nowhere to go but a form. An instant reply would catch them while they are still shopping.", opener: "Hi, this is [your name] with SarvX. I was on your website last night looking at a truck and noticed there was no way to get a quick answer — is that something your team has been thinking about?", question: "When a lead comes in through the website at 9 pm, who sees it first, and when?", nextAction: "Call the Internet Sales Manager", claims: [{ text: "No chat widget on the website", kind: "OBSERVED" }, { text: "1 lead form (contact)", kind: "OBSERVED" }, { text: "Hiring an Internet Sales Manager and a BDC Representative", kind: "OBSERVED" }, { text: "3 unanswered pricing questions on Instagram", kind: "OBSERVED" }, { text: "After-hours leads likely wait until morning", kind: "INFERENCE" }], generatedAt: now },
      };
    case "orion":
      return { kind: "orion", queues: [], window: { open: true, label: "Demo: research hours open" } };
    case "echo":
      return { kind: "echo", open: [{ id: "demo-test", dealershipName: DEMO_DEALER.name, testType: "FORM", submittedAt: new Date(Date.now() - 18 * 60_000).toISOString(), firstResponseSeconds: null }], channels: { EMAIL: 3, SMS: 1, PHONE: 0, CHAT: 2 } };
    case "sentinel":
      return { kind: "sentinel", coverage: { estimated: 1, total: 1 }, latest: [{ dealershipId: "demo", dealershipName: DEMO_DEALER.name, unitsLow: 19, unitsHigh: 26, grossLow: 342_000, grossHigh: 468_000, profitLow: 36_100, profitHigh: 67_600, profitPerUnit: 2_250, segment: "MAINSTREAM", method: "LOT_SIZE", confidence: "LOW", onHand: 48, at: now }] };
  }
}
