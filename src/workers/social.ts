import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { socialObservations, socialProfiles, type SocialObservation } from "@/db/schema";
import type { Confidence } from "@/domain/constants";
import { publicProfileConnector } from "./social/public-profile";
import { emit } from "@/lib/agent-events";

/**
 * Social intelligence is collected only through authorised APIs. A connector wraps one platform's
 * official API (for example the Meta Graph API with a page token the dealership or we are entitled
 * to use). Nothing here scrapes logged-in pages, works around rate limits, or sends messages.
 */
export type SocialConnectorResult = Pick<
  SocialObservation,
  "postsLast30Days" | "inventoryPostsLast30Days" | "customerQuestions" | "unansweredQuestions" | "adActivity" | "notes" | "followers" | "totalPosts" | "publiclyVisible"
> & { confidence: Confidence; sourceUrl: string };

export interface SocialConnector {
  readonly name: string;
  /** Platforms this connector handles. */
  readonly platforms: readonly string[];
  /** False when credentials for this platform are not configured. */
  isConfigured(): boolean;
  fetch(profileUrl: string): Promise<SocialConnectorResult>;
}

/**
 * One connector ships: it reads the figures a profile page shows publicly, without signing in
 * (followers, post counts). Posting frequency and unanswered questions still come from operators
 * (Dealership → Social → "Record observation"), each stored with its source URL.
 */
export const SOCIAL_CONNECTORS: SocialConnector[] = [publicProfileConnector];

export async function runSocialScan(dealershipId: string): Promise<string> {
  const profiles = await db().select().from(socialProfiles).where(eq(socialProfiles.dealershipId, dealershipId)).orderBy(desc(socialProfiles.lastSeen));
  if (profiles.length === 0) return "SKIPPED: no social profiles found on the dealership website yet";
  const active = SOCIAL_CONNECTORS.filter((c) => c.isConfigured());
  if (active.length === 0) return "SKIPPED: no social connector is configured (operator-entered observations only)";

  let stored = 0;
  for (const profile of profiles) {
    const connector = active.find((c) => c.platforms.includes(profile.platform));
    if (!connector) continue;
    try {
      await emit(`Reading ${profile.platform} profile`, { detail: profile.url });
      const r = await connector.fetch(profile.url);
      await db().insert(socialObservations).values({ dealershipId, platform: profile.platform, source: connector.name, recordedBy: `system:${connector.name}`, ...r });
      await emit(`${profile.platform}: ${r.notes ?? "read"}`, { status: r.publiclyVisible ? "DONE" : "BLOCKED", kind: "finding.created" });
      stored += 1;
    } catch (err) {
      // One unreachable platform must not fail the whole job; the others still get recorded.
      await db().insert(socialObservations).values({ dealershipId, platform: profile.platform, source: connector.name, recordedBy: `system:${connector.name}`, sourceUrl: profile.url, confidence: "LOW", publiclyVisible: null, notes: `Could not read the page: ${(err as Error).message.slice(0, 160)}` });
    }
  }
  return `OK: ${stored} of ${profiles.length} platform(s) read`;
}
