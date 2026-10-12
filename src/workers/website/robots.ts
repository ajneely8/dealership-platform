/**
 * Minimal robots.txt handling: Allow/Disallow with `*` and `$`, longest-match-wins,
 * our own user-agent group preferred over `*`. Unreadable robots files are treated as "allow"
 * (the standard interpretation of a 4xx), while a 5xx is treated as "disallow everything".
 */
export type RobotsRules = { allow: string[]; disallow: string[]; crawlDelaySeconds: number | null };

export const ALLOW_ALL: RobotsRules = { allow: [], disallow: [], crawlDelaySeconds: null };
export const DISALLOW_ALL: RobotsRules = { allow: [], disallow: ["/"], crawlDelaySeconds: null };

export function parseRobots(text: string, agentToken: string): RobotsRules {
  const groups = new Map<string, RobotsRules>();
  let current: string[] = [];
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!lastWasAgent) current = [];
      const agent = value.toLowerCase();
      current.push(agent);
      if (!groups.has(agent)) groups.set(agent, { allow: [], disallow: [], crawlDelaySeconds: null });
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    for (const agent of current) {
      const g = groups.get(agent)!;
      if (key === "allow" && value) g.allow.push(value);
      else if (key === "disallow" && value) g.disallow.push(value);
      else if (key === "crawl-delay" && !Number.isNaN(Number(value))) g.crawlDelaySeconds = Number(value);
    }
  }
  const token = agentToken.toLowerCase();
  const own = [...groups.entries()].find(([agent]) => agent !== "*" && token.includes(agent));
  return own?.[1] ?? groups.get("*") ?? ALLOW_ALL;
}

function toRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

export function isAllowed(rules: RobotsRules, pathAndQuery: string): boolean {
  let best: { length: number; allow: boolean } | null = null;
  const consider = (patterns: string[], allow: boolean) => {
    for (const p of patterns) {
      if (!toRegex(p).test(pathAndQuery)) continue;
      // Longest pattern wins; on a tie, Allow wins.
      if (!best || p.length > best.length || (p.length === best.length && allow)) best = { length: p.length, allow };
    }
  };
  consider(rules.disallow, false);
  consider(rules.allow, true);
  return best === null ? true : (best as { allow: boolean }).allow;
}

export async function fetchRobots(origin: string, userAgent: string, agentToken: string): Promise<RobotsRules> {
  try {
    const res = await fetch(`${origin}/robots.txt`, { headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(10_000), redirect: "follow" });
    if (res.status >= 500) return DISALLOW_ALL;
    if (!res.ok) return ALLOW_ALL;
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("html")) return ALLOW_ALL; // soft-404 page, not a robots file
    return parseRobots((await res.text()).slice(0, 200_000), agentToken);
  } catch {
    // Network failure fetching robots: the homepage visit will surface the real problem.
    return ALLOW_ALL;
  }
}
