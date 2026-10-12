import { z } from "zod";
import { db } from "@/db";
import { settings as settingsTable } from "@/db/schema";
import { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS } from "@/domain/scoring/config";

/**
 * Admin-editable settings. Stored one row per key; anything missing falls back to the default
 * below. Hard safety ceilings live in env.ts and are applied on top (see effectiveLimits()).
 */
export const settingsSchema = z.object({
  /** Master switch for controlled interactions. Off by default: the product is passive until an admin turns this on. */
  testingEnabled: z.boolean().default(false),
  interactionCooldownDays: z.number().int().min(30).max(365).default(30),
  maxChatMessages: z.number().int().min(0).max(3).default(3),
  maxHumanReplies: z.number().int().min(0).max(1).default(1),
  responseMonitorHours: z.number().int().min(1).max(168).default(72),
  websiteScanIntervalDays: z.number().int().min(1).max(90).default(14),
  inventoryScanIntervalDays: z.number().int().min(1).max(30).default(7),
  socialScanIntervalDays: z.number().int().min(1).max(30).default(3),
  signalScanIntervalDays: z.number().int().min(1).max(30).default(1),
  aiProvider: z.enum(["env", "anthropic", "none"]).default("env"),
  aiModel: z.string().max(100).default(""),
  /** Passive research and browser tests run only inside this daily window; inbound replies are recorded 24/7. */
  prospectingEnabled: z.boolean().default(true),
  prospectIntervalSeconds: z.number().int().min(15).max(3600).default(30),
  prospectingAroundTheClock: z.boolean().default(true),
  prospectCenterLat: z.number().min(-90).max(90).default(29.4241),
  prospectCenterLng: z.number().min(-180).max(180).default(-98.4936),
  prospectRadiusKm: z.number().int().min(10).max(400).default(120),
  /** Rotate through metro areas across the United States instead of one centre. */
  prospectNationwide: z.boolean().default(true),
  /** manual | request | auto — what happens for an admitted dealership with a reachable chat widget. */
  chatTestMode: z.enum(["manual", "request", "auto"]).default("auto"),
  /** What Charlie says when it calls. Fixed per setting, spoken by the provider's voice. */
  phoneCheckScript: z.string().min(10).max(300).default("Hi, I'm calling about a vehicle I saw listed on your website. Is it still available?"),
  /** manual = call only when an operator asks; auto = call each newly admitted dealership once (needs Twilio). */
  phoneCheckMode: z.enum(["manual", "auto"]).default("auto"),
  /** Hang up the moment a person answers (nothing is said to them); only machines and AI receptionists hear the script. */
  phoneHangUpOnHuman: z.boolean().default(true),
  /** How passive research presents its browser: "visitor" (a normal Chrome, research tag kept in the user agent) or "research" (headless, which many sites refuse outright). */
  researchPresentation: z.enum(["visitor", "research"]).default("visitor"),
  researchWindowEnabled: z.boolean().default(true),
  researchWindowStart: z.string().regex(/^\d{2}:\d{2}$/).default("07:00"),
  researchWindowEnd: z.string().regex(/^\d{2}:\d{2}$/).default("21:00"),
  /** IANA zone, so daylight-saving changes are handled by the platform. */
  timezone: z.string().min(3).max(64).default("America/Chicago"),
  maxAIRequestsPerJob: z.number().int().min(0).max(20).default(3),
  maxAITokensPerJob: z.number().int().min(0).max(200_000).default(20_000),
  screenshotRetentionDays: z.number().int().min(7).max(3650).default(180),
  evidenceRetentionDays: z.number().int().min(30).max(3650).default(365),
  scoringWeights: z.record(z.string(), z.number().int().min(0).max(100)).default(DEFAULT_WEIGHTS),
  scoringThresholds: z
    .object({
      largeInventory: z.number().int().min(1),
      inventoryMovementPct: z.number().min(1).max(100),
      schedulerFieldCount: z.number().int().min(1),
      socialPostsPerMonth: z.number().int().min(1),
      socialInventoryPostsPerMonth: z.number().int().min(1),
      socialCustomerQuestions: z.number().int().min(1),
      socialUnansweredQuestions: z.number().int().min(1),
      signalRecencyDays: z.number().int().min(1),
    })
    .default(DEFAULT_THRESHOLDS),
});

export type Settings = z.infer<typeof settingsSchema>;
export type SettingKey = keyof Settings;

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

export async function getSettings(): Promise<Settings> {
  const rows = await db().select().from(settingsTable);
  const raw: Record<string, unknown> = {};
  for (const r of rows) raw[r.key] = r.value;
  // Weights: stored overrides are merged over defaults so newly added rules get their default weight.
  if (raw.scoringWeights && typeof raw.scoringWeights === "object") raw.scoringWeights = { ...DEFAULT_WEIGHTS, ...(raw.scoringWeights as object) };
  if (raw.scoringThresholds && typeof raw.scoringThresholds === "object") {
    raw.scoringThresholds = { ...DEFAULT_THRESHOLDS, ...(raw.scoringThresholds as object) };
  }
  const parsed = settingsSchema.safeParse(raw);
  // A corrupt row must not take the whole app down; fall back to defaults for safety-first behaviour.
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export async function updateSettings(patch: Partial<Settings>, actor: string): Promise<Settings> {
  const current = await getSettings();
  const next = settingsSchema.parse({ ...current, ...patch });
  const now = new Date();
  for (const key of Object.keys(patch) as SettingKey[]) {
    const value = next[key];
    await db()
      .insert(settingsTable)
      .values({ key, value, updatedBy: actor, updatedAt: now })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedBy: actor, updatedAt: now } });
  }
  return next;
}
