import type { Page } from "playwright";

/**
 * The structured data pulled out of one page. This — not raw HTML — is what detectors,
 * scoring and (later) the AI layer see. A typical snapshot is a few KB.
 */
export type RawField = { tag: string; type: string; name: string; label: string; required: boolean; visible: boolean };

export type RawForm = {
  action: string | null;
  idClass: string;
  /** Nearest heading plus the submit button text: the best cheap clue to what the form is for. */
  context: string;
  fields: RawField[];
  hasCaptcha: boolean;
};

export type PageSnapshot = {
  url: string;
  title: string | null;
  httpStatus: number | null;
  viewportMeta: boolean;
  scripts: string[];
  iframes: string[];
  /** Vendor keywords found inside inline scripts (matched in-page so the script bodies never leave the browser). */
  inlineHints: string[];
  links: { href: string; text: string }[];
  forms: RawForm[];
  /** Short visible strings (headings, list items, link text) — used for job titles and counts. */
  shortTexts: string[];
  /** Asking prices as the page shows them (digits only, e.g. "12,995"), read from the whole body and from price-labelled elements. */
  priceTexts: string[];
  /** The dealer hides prices behind "Contact Dealer" / "Call for price" on most listings. */
  hidesPrices: boolean;
  /** First ~6,000 characters of visible body text. */
  text: string;
  jsonLd: unknown[];
  generator: string | null;
  hasCaptcha: boolean;
  telLinks: string[];
  smsLinks: string[];
};

/**
 * Runs inside the page. Must stay self-contained: no closures over module scope.
 * `hintKeywords` are matched against inline <script> bodies.
 */
function collect(hintKeywords: string[]) {
  const abs = (href: string | null): string | null => {
    if (!href) return null;
    try {
      return new URL(href, document.baseURI).toString();
    } catch {
      return null;
    }
  };
  const clean = (s: string | null | undefined, max: number): string => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const isVisible = (el: Element): boolean => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };
  const labelFor = (el: Element): string => {
    const id = el.getAttribute("id");
    const byFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    return clean(
      byFor?.textContent ?? el.closest("label")?.textContent ?? el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? el.getAttribute("title"),
      80,
    );
  };
  const captchaSelector =
    'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]';

  const scripts = Array.from(document.scripts);
  const inlineHints: string[] = [];
  for (const s of scripts) {
    if (s.src) continue;
    const body = (s.textContent ?? "").toLowerCase();
    if (!body) continue;
    for (const k of hintKeywords) if (!inlineHints.includes(k) && body.includes(k)) inlineHints.push(k);
  }

  const links: { href: string; text: string }[] = [];
  const telLinks: string[] = [];
  const smsLinks: string[] = [];
  for (const a of Array.from(document.querySelectorAll("a[href]")).slice(0, 1500)) {
    const raw = a.getAttribute("href") ?? "";
    if (raw.startsWith("tel:")) {
      telLinks.push(raw.slice(4));
      continue;
    }
    if (raw.startsWith("sms:")) {
      smsLinks.push(raw.slice(4));
      continue;
    }
    if (raw.startsWith("#") || raw.startsWith("javascript:") || raw.startsWith("mailto:")) continue;
    const href = abs(raw);
    if (!href) continue;
    const text = clean(a.textContent || a.getAttribute("aria-label") || a.getAttribute("title") || a.querySelector("img")?.getAttribute("alt"), 100);
    links.push({ href, text });
  }

  const forms = Array.from(document.forms)
    .slice(0, 30)
    .map((form) => {
      const fields = Array.from(form.querySelectorAll("input, select, textarea"))
        .map((el) => {
          const type = (el.getAttribute("type") ?? el.tagName).toLowerCase();
          return {
            tag: el.tagName.toLowerCase(),
            type,
            name: clean(el.getAttribute("name") ?? el.getAttribute("id"), 80),
            label: labelFor(el),
            required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
            visible: type !== "hidden" && isVisible(el),
          };
        })
        .filter((f) => !["submit", "button", "image", "reset"].includes(f.type))
        .slice(0, 60);
      const container = form.closest("section, article, aside, [class*='form'], [class*='modal'], div") ?? form;
      const heading = container.querySelector("h1, h2, h3, h4, legend")?.textContent;
      const submit = form.querySelector("button[type=submit], input[type=submit], button:not([type])");
      const submitText = submit?.textContent || submit?.getAttribute("value");
      return {
        action: abs(form.getAttribute("action")),
        idClass: clean(`${form.id} ${form.className}`, 120),
        context: clean(`${heading ?? ""} | ${submitText ?? ""}`, 200),
        fields,
        hasCaptcha: form.querySelector(captchaSelector) !== null,
      };
    });

  const shortTexts: string[] = [];
  const seen = new Set<string>();
  for (const el of Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, li, a, [class*='job'], [class*='position'], [class*='opening'], [class*='count'], [class*='result']")).slice(0, 4000)) {
    // A wrapper (e.g. <ul class="jobs">) would repeat all of its children's text as one string; take leaves only.
    if (!/^(A|H[1-5]|LI)$/.test(el.tagName) && el.children.length > 0) continue;
    const t = clean(el.textContent, 140);
    if (t.length < 3 || t.length > 120 || seen.has(t)) continue;
    seen.add(t);
    shortTexts.push(t);
    if (shortTexts.length >= 500) break;
  }

  // Asking prices, from the whole body (not the 6,000-character text slice) and from elements
  // labelled as prices; payments ("$299/mo") are skipped. Also whether prices are hidden.
  const bodyText = document.body?.innerText ?? "";
  const priceRe = /\$\s?(\d{1,3}(?:,\d{3})+|\d{4,6})(?!\d)(?!\s?\/\s?(?:mo|month|wk|week|bi-?weekly))/gi;
  const priceTexts: string[] = [];
  for (const m of bodyText.matchAll(priceRe)) {
    priceTexts.push(m[1]!);
    if (priceTexts.length >= 400) break;
  }
  for (const el of Array.from(document.querySelectorAll("[class*='price' i], [id*='price' i], [data-price], [itemprop='price']")).slice(0, 400)) {
    if (el.children.length > 3) continue; // a whole card or filter block, not one price
    const t = ((el as HTMLElement).innerText || el.getAttribute("content") || el.getAttribute("data-price") || "").trim();
    if (!t || /\/\s?(mo|month|wk|week)/i.test(t)) continue;
    for (const m of t.matchAll(priceRe)) priceTexts.push(m[1]!);
    const bare = /^(\d{1,3}(?:,\d{3})+|\d{4,6})$/.exec(t);
    if (bare) priceTexts.push(bare[1]!);
    if (priceTexts.length >= 800) break;
  }
  const hidesPrices = (bodyText.match(/contact (?:dealer|us) for (?:the )?price|call for price|contact dealer|price on request|inquire for price|see dealer for price|get e-?price/gi) ?? []).length >= 3;

  const jsonLd: unknown[] = [];
  for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 10)) {
    try {
      jsonLd.push(JSON.parse(s.textContent ?? ""));
    } catch {
      // Malformed JSON-LD is common and not worth failing a scan over.
    }
  }

  return {
    title: clean(document.title, 200) || null,
    viewportMeta: document.querySelector('meta[name="viewport"]') !== null,
    scripts: scripts.map((s) => s.src).filter(Boolean).slice(0, 300),
    iframes: Array.from(document.querySelectorAll("iframe"))
      .map((f) => f.getAttribute("src") ?? f.getAttribute("data-src") ?? "")
      .filter(Boolean)
      .slice(0, 60),
    inlineHints,
    links: links.slice(0, 800),
    forms,
    shortTexts,
    priceTexts: priceTexts.slice(0, 800),
    hidesPrices,
    text: clean(document.body?.innerText, 6000),
    jsonLd,
    generator: document.querySelector('meta[name="generator"]')?.getAttribute("content") ?? null,
    hasCaptcha: document.querySelector(captchaSelector) !== null,
    telLinks: telLinks.slice(0, 20),
    smsLinks: smsLinks.slice(0, 20),
  };
}

export async function takeSnapshot(page: Page, httpStatus: number | null, hintKeywords: string[]): Promise<PageSnapshot> {
  const data = await page.evaluate(collect, hintKeywords);
  return { url: page.url(), httpStatus, ...data };
}

/** Measured at a phone-sized viewport: a viewport meta tag and no sideways scrolling. */
export async function checkMobileFriendly(page: Page): Promise<boolean> {
  const original = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const ok = await page.evaluate(() => {
    const hasMeta = document.querySelector('meta[name="viewport"]') !== null;
    return hasMeta && document.documentElement.scrollWidth <= window.innerWidth + 16;
  });
  if (original) await page.setViewportSize(original);
  return ok;
}
