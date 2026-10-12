import { z } from "zod";

const bool = (def: boolean) =>
  z
    .enum(["true", "false"])
    .default(def ? "true" : "false")
    .transform((v) => v === "true");

/**
 * The spec's ALLOW_* switches exist so the limits are visible in configuration, but V1
 * has no code path that books appointments, submits finance/trade-in forms or requests
 * test drives. Refusing to boot when one is set to "true" is safer than silently ignoring it.
 */
const mustBeFalse = z.literal("false").default("false");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:5310"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  DATABASE_URL: z.string().min(1),
  /** Empty in the hosted viewer (Vercel): no queue, no workers; the research data is read as synced. */
  REDIS_URL: z.string().default(""),

  ADMIN_EMAIL: z.string().email().optional().or(z.literal("")),
  ADMIN_PASSWORD: z.string().optional(),

  STORAGE_DRIVER: z.enum(["s3", "local"]).default("s3"),
  STORAGE_LOCAL_DIR: z.string().default(".data/evidence"),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default("dealer-intel-evidence"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool(true),

  AI_PROVIDER: z.enum(["anthropic", "none"]).default("none"),
  AI_MODEL: z.string().default("claude-opus-5-5"),
  ANTHROPIC_API_KEY: z.string().optional(),

  WEBHOOK_SECRET: z.string().optional(),
  // Phone checks (Twilio Programmable Voice). Optional: without them the phone check reports "not configured".
  // Realistic agent voices. Either key works; TTS_PROVIDER picks when both are set.
  TTS_PROVIDER: z.enum(["auto", "openai", "elevenlabs", "windows"]).default("auto"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_TTS_MODEL: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),

  CRAWLER_USER_AGENT_SUFFIX: z.string().default("DealerIntelResearch/0.1"),
  CRAWLER_PAGE_DELAY_MS: z.coerce.number().int().min(0).default(400),
  CRAWLER_MAX_PAGES: z.coerce.number().int().min(1).max(25).default(10),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  /** Dev/test only: lets the crawler reach localhost fixture sites. Never enable in production. */
  ALLOW_LOCAL_TARGETS: bool(false),

  MAX_CHAT_MESSAGES: z.coerce.number().int().min(0).max(3).default(3),
  MAX_TESTS_PER_DEALERSHIP_PER_30_DAYS: z.coerce.number().int().min(0).max(1).default(1),
  MAX_HUMAN_REPLIES: z.coerce.number().int().min(0).max(1).default(1),
  ALLOW_APPOINTMENT_BOOKING: mustBeFalse,
  ALLOW_FINANCE_APPLICATIONS: mustBeFalse,
  ALLOW_TRADE_IN: mustBeFalse,
  ALLOW_TEST_DRIVE: mustBeFalse,
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Parsed lazily so `next build` and unit tests don't need a full environment. */
export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
