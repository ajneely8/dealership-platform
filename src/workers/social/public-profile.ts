import { assertAllowedTarget, Crawler } from "../website/crawler";
import type { SocialConnector, SocialConnectorResult } from "../social";

/**
 * Reads what a social profile page shows to anyone, without signing in: the follower and post
 * counts platforms put in their page metadata for link previews. That is all. It never logs in,
 * never loads a feed, and reports a login wall as "not publicly visible" rather than working
 * around it. Unanswered questions and DM behaviour stay unknown unless an operator records them.
 */

export type PublicProfileRead = { followers: number | null; totalPosts: number | null; publiclyVisible: boolean; note: string };

/** "12.3K" → 12300, "1,234" → 1234, "2M" → 2000000 */
export function parseCount(raw: string): number | null {
  const m = /^([\d.,]+)\s*([KkMm])?$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ""));
  if (Number.isNaN(n)) return null;
  const mult = m[2]?.toLowerCase() === "k" ? 1_000 : m[2]?.toLowerCase() === "m" ? 1_000_000 : 1;
  return Math.round(n * mult);
}

function meta(html: string, prop: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, "i");
  const alt = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, "i");
  const hit = re.exec(html) ?? alt.exec(html);
  return hit ? hit[1]!.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"') : null;
}

const LOGIN_WALL = /log ?in to (facebook|instagram|tiktok)|login • instagram|log into facebook|sign in to continue|you must log in/i;

export function parsePublicProfile(html: string, platform: string): PublicProfileRead {
  const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? "").trim();
  const description = meta(html, "og:description") ?? meta(html, "description") ?? "";
  const text = `${title} ${description}`;
  if (LOGIN_WALL.test(text) && !/followers|likes|subscribers/i.test(description)) {
    return { followers: null, totalPosts: null, publiclyVisible: false, note: "The platform showed a sign-in page instead of the profile; nothing was read." };
  }
  let followers: number | null = null;
  let totalPosts: number | null = null;
  const grab = (re: RegExp) => {
    const m = re.exec(text);
    return m ? parseCount(m[1]!) : null;
  };
  switch (platform) {
    case "instagram":
      followers = grab(/([\d.,]+[KkMm]?)\s+Followers/);
      totalPosts = grab(/([\d.,]+[KkMm]?)\s+Posts/);
      break;
    case "facebook":
      followers = grab(/([\d.,]+[KkMm]?)\s+(?:likes|followers)/i);
      break;
    case "tiktok":
      followers = grab(/([\d.,]+[KkMm]?)\s+Followers/);
      break;
    case "youtube":
      followers = grab(/([\d.,]+[KkMm]?)\s+subscribers/i);
      totalPosts = grab(/([\d.,]+[KkMm]?)\s+videos/i);
      break;
    default:
      followers = grab(/([\d.,]+[KkMm]?)\s+(?:followers|subscribers|likes)/i);
  }
  const parts = [followers !== null ? `${followers.toLocaleString("en-US")} followers` : null, totalPosts !== null ? `${totalPosts.toLocaleString("en-US")} posts` : null].filter(Boolean);
  return {
    followers,
    totalPosts,
    publiclyVisible: true,
    note: parts.length ? `Public page: ${parts.join(", ")} (read from page metadata, no sign-in)` : "Public page reachable, but it showed no follower or post counts.",
  };
}

export const publicProfileConnector: SocialConnector = {
  name: "public-page",
  platforms: ["facebook", "instagram", "tiktok", "youtube", "x", "linkedin", "pinterest"],
  isConfigured: () => true,
  async fetch(profileUrl: string): Promise<SocialConnectorResult> {
    // A real browser, because several platforms answer plain HTTP clients with an error page.
    // Same crawler as the website scan: SSRF guard, robots.txt, identified user agent, no sign-in.
    const url = assertAllowedTarget(profileUrl).toString();
    const platform = publicProfileConnector.platforms.find((p) => new URL(url).hostname.includes(p === "x" ? "x.com" : p)) ?? "other";
    const crawler = await Crawler.open({ maxPages: 1 });
    try {
      const visit = await crawler.visit(url, "ABOUT");
      if (visit.page.outcome === "ROBOTS_DISALLOWED") {
        return { ...EMPTY, sourceUrl: url, publiclyVisible: false, notes: "The platform's robots.txt asks automated visitors not to read this page; nothing was read." };
      }
      if (visit.page.outcome === "ERROR" && !visit.page.httpStatus) {
        return { ...EMPTY, sourceUrl: url, publiclyVisible: false, notes: `The page did not load (${visit.page.detail ?? "unknown error"}).` };
      }
      // Even a sign-in wall carries the page's metadata, which is all we read.
      const html = (await crawler.page.content()).slice(0, 1_500_000);
      const read = parsePublicProfile(html, platform);
      return { ...EMPTY, sourceUrl: url, followers: read.followers, totalPosts: read.totalPosts, publiclyVisible: read.publiclyVisible, notes: read.note };
    } finally {
      await crawler.close();
    }
  },
};

const EMPTY = {
  confidence: "LOW" as const,
  postsLast30Days: null,
  inventoryPostsLast30Days: null,
  customerQuestions: null,
  unansweredQuestions: null,
  adActivity: null,
  followers: null,
  totalPosts: null,
  publiclyVisible: null as boolean | null,
  notes: null as string | null,
};
