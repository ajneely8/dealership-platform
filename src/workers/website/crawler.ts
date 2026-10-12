import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { VisitedPage } from "@/db/schema";
import { env } from "@/env";
import { logger } from "@/lib/logger";
import { detectBlock } from "./detect";
import { fetchRobots, isAllowed, type RobotsRules } from "./robots";
import { takeSnapshot, type PageSnapshot } from "./snapshot";
import { INLINE_HINT_KEYWORDS } from "./vendors";
import { registerJobCleanup } from "@/lib/job-context";

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[?::1\]?)|\.(local|internal|lan)$/i;

/** SSRF guard: research targets must be public websites. Local fixtures need ALLOW_LOCAL_TARGETS=true (dev/test only). */
export function assertAllowedTarget(url: string): URL {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`Unsupported protocol: ${u.protocol}`);
  // Automated tests may only ever touch local fixture sites — never a real dealership.
  if (env().NODE_ENV === "test" && !PRIVATE_HOST.test(u.hostname)) throw new Error(`Tests may not visit external host ${u.hostname}`);
  if (PRIVATE_HOST.test(u.hostname) && !(env().ALLOW_LOCAL_TARGETS && env().NODE_ENV !== "production")) {
    throw new Error(`Refusing to visit private/local address ${u.hostname}`);
  }
  return u;
}

export type Visit = { page: VisitedPage; snapshot: PageSnapshot | null };

/**
 * One polite browsing session against one site: honours robots.txt, waits between page loads,
 * enforces a page budget, and stops at anything that looks like an access control.
 * It identifies itself in the user agent and makes no attempt to look like a regular visitor.
 */
export class Crawler {
  private readonly robots = new Map<string, RobotsRules>();
  private visits = 0;
  private lastVisitAt = 0;

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    readonly page: Page,
    private readonly userAgent: string,
    private readonly maxPages: number,
  ) {}

  /**
   * `present` controls the browser identity. "research" (default, passive scans) appends the
   * research suffix to the headless browser's own UA. "visitor" is for approved controlled tests:
   * the HeadlessChrome token becomes Chrome so chat vendors serve the same widget a customer gets,
   * and the research suffix stays on so the visit is still identifiable in their logs.
   */
  static async open(opts: { maxPages?: number; present?: "research" | "visitor" } = {}): Promise<Crawler> {
    const e = env();
    const browser = await chromium.launch({ headless: true });
    try {
      const probe = await browser.newContext();
      const baseUa = await (await probe.newPage()).evaluate(() => navigator.userAgent);
      await probe.close();
      const userAgent = `${opts.present === "visitor" ? baseUa.replace("HeadlessChrome", "Chrome") : baseUa} ${e.CRAWLER_USER_AGENT_SUFFIX}`;
      const context = await browser.newContext({ userAgent, viewport: { width: 1366, height: 900 }, locale: "en-US" });
      // tsx compiles with keepNames, which wraps functions passed to page.evaluate in a __name() helper.
      await context.addInitScript("globalThis.__name = (fn) => fn;");
      context.setDefaultNavigationTimeout(30_000);
      const page = await context.newPage();
      // Research never needs to download anything.
      page.on("download", (d) => void d.cancel().catch(() => undefined));
      page.on("dialog", (d) => void d.dismiss().catch(() => undefined));
      const crawler = new Crawler(browser, context, page, userAgent, opts.maxPages ?? e.CRAWLER_MAX_PAGES);
      crawler.unregister = registerJobCleanup(() => crawler.close());
      return crawler;
    } catch (err) {
      await browser.close();
      throw err;
    }
  }

  get agentToken(): string {
    return env().CRAWLER_USER_AGENT_SUFFIX.split("/")[0] ?? "DealerIntelResearch";
  }

  get budgetLeft(): number {
    return this.maxPages - this.visits;
  }

  private async rulesFor(u: URL): Promise<RobotsRules> {
    let rules = this.robots.get(u.origin);
    if (!rules) {
      rules = await fetchRobots(u.origin, this.userAgent, this.agentToken);
      this.robots.set(u.origin, rules);
    }
    return rules;
  }

  async visit(url: string, kind: VisitedPage["kind"]): Promise<Visit> {
    const base: VisitedPage = { url, kind, title: null, httpStatus: null, outcome: "ERROR" };
    let target: URL;
    try {
      target = assertAllowedTarget(url);
    } catch (err) {
      return { page: { ...base, detail: (err as Error).message }, snapshot: null };
    }
    if (this.budgetLeft <= 0) return { page: { ...base, detail: "Page budget exhausted" }, snapshot: null };

    const rules = await this.rulesFor(target);
    if (!isAllowed(rules, target.pathname + target.search)) {
      return { page: { ...base, outcome: "ROBOTS_DISALLOWED", detail: "Disallowed by robots.txt" }, snapshot: null };
    }

    const delay = Math.min(10_000, Math.max(env().CRAWLER_PAGE_DELAY_MS, (rules.crawlDelaySeconds ?? 0) * 1000));
    const wait = this.lastVisitAt + delay - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    this.visits += 1;
    try {
      const response = await this.page.goto(url, { waitUntil: "domcontentloaded" });
      this.lastVisitAt = Date.now();
      // Chat widgets and schedulers load late; give them a moment, but never hang on a busy page.
      await this.page.waitForLoadState("networkidle", { timeout: 2_500 }).catch(() => undefined);
      await this.page.waitForTimeout(500);
      const status = response?.status() ?? null;
      const snapshot = await takeSnapshot(this.page, status, INLINE_HINT_KEYWORDS);
      const blocked = detectBlock(snapshot);
      if (blocked) {
        return { page: { ...base, url: snapshot.url, title: snapshot.title, httpStatus: status, outcome: "BLOCKED", detail: blocked }, snapshot: null };
      }
      if (status !== null && status >= 400) {
        return { page: { ...base, url: snapshot.url, title: snapshot.title, httpStatus: status, detail: `HTTP ${status}` }, snapshot: null };
      }
      return { page: { ...base, url: snapshot.url, title: snapshot.title, httpStatus: status, outcome: "OK" }, snapshot };
    } catch (err) {
      this.lastVisitAt = Date.now();
      const message = (err as Error).message.split("\n")[0] ?? "Navigation failed";
      logger.warn({ url, err: message }, "page visit failed");
      return { page: { ...base, detail: message.slice(0, 300) }, snapshot: null };
    }
  }

  /** Viewport screenshot of whatever is currently loaded. JPEG keeps evidence storage small. */
  async screenshot(): Promise<Buffer> {
    return this.page.screenshot({ type: "jpeg", quality: 60, fullPage: false });
  }

  private unregister: () => void = () => undefined;
  private closed = false;

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unregister();
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }
}
