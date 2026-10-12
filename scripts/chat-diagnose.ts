/**
 * Chat-widget diagnosis: opens a dealership homepage exactly the way Charlie does (same crawler,
 * same identified browser) and reports what a chat launcher search sees, second by second.
 *
 *   npm run chat-diagnose -- https://www.stoepelford.com/
 */
import { Crawler } from "@/workers/website/crawler";

const LAUNCHER = /\b(chat|text us|message us|let'?s talk|ask (us|a question)|talk to us|live help)\b/i;

async function main() {
  const url = process.argv[2];
  if (!url) throw new Error("usage: chat-diagnose <url>");
  const present = (process.argv[3] === "visitor" ? "visitor" : "research") as "visitor" | "research";
  console.log("presenting as:", present);
  const crawler = await Crawler.open({ maxPages: 1, present });
  try {
    const visit = await crawler.visit(url, "HOMEPAGE");
    console.log("visit:", visit.page.outcome, visit.page.detail ?? "", "final url:", visit.snapshot?.url);
    const page = crawler.page;
    for (let t = 0; t <= 20; t += 4) {
      await page.waitForTimeout(t === 0 ? 1000 : 4000);
      const frames = page.frames();
      const report: string[] = [];
      for (const f of frames) {
        const items = await f
          .evaluate((reSrc) => {
            const re = new RegExp(reSrc, "i");
            return [...document.querySelectorAll("button, a, [role=button], div[onclick], div[tabindex]")]
              .map((e) => {
                const el = e as HTMLElement;
                const text = [el.innerText, el.getAttribute("aria-label"), el.getAttribute("title")].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                return { text: text.slice(0, 50), cls: String(el.className).slice(0, 50), w: Math.round(r.width), h: Math.round(r.height), vis: r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0" };
              })
              .filter((x) => re.test(x.text));
          }, LAUNCHER.source)
          .catch(() => []);
        if (items.length) report.push(`  frame ${f.url().slice(0, 80)}: ${JSON.stringify(items)}`);
      }
      const scripts = await page.evaluate(() => [...document.scripts].map((s) => s.src).filter((s) => /carnow|gubagoo|podium|impel|livechat|chat/i.test(s)).slice(0, 6));
      console.log(`t+${t + 1}s frames=${frames.length} vendor scripts=${scripts.length}`);
      for (const r of report) console.log(r);
      if (report.length === 0) console.log("  (no launcher-like element)");
    }
    const { writeFileSync } = await import("node:fs");
    // Open the widget and watch what appears inside it.
    const launcher = page.locator("button, a, [role=button], div[onclick], div[tabindex]").filter({ hasText: LAUNCHER }).filter({ visible: true }).first();
    if ((await launcher.count()) > 0) {
      console.log("clicking launcher:", (await launcher.innerText()).trim().slice(0, 40));
      await launcher.click({ timeout: 10_000 });
      for (let t = 0; t <= 20; t += 4) {
        await page.waitForTimeout(t === 0 ? 1500 : 4000);
        const frames = page.frames();
        console.log(`after click t+${t + 1.5}s frames=${frames.length}`);
        for (const f of frames) {
          const inputs = await f
            .evaluate(() =>
              [...document.querySelectorAll("textarea, input, [contenteditable=true], [role=textbox], button")]
                .map((e) => {
                  const el = e as HTMLElement;
                  const r = el.getBoundingClientRect();
                  return { tag: el.tagName, type: el.getAttribute("type"), id: el.id, ph: el.getAttribute("placeholder"), aria: el.getAttribute("aria-label"), text: (el.innerText || "").trim().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) };
                })
                .filter((x) => x.w > 0 && x.h > 0),
            )
            .catch(() => [] as unknown[]);
          if (inputs.length) console.log(`  ${f.url().slice(0, 70)} → ${JSON.stringify(inputs).slice(0, 900)}`);
        }
        writeFileSync(`scripts/chat-diagnose-after-${t}.png`, await crawler.screenshot());
      }
    }
    writeFileSync("scripts/chat-diagnose.png", await crawler.screenshot());
    console.log("screenshots → scripts/chat-diagnose*.png");
  } finally {
    await crawler.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
