import { sql } from "drizzle-orm";
import { db } from "@/db";
import { queuesAvailable, redis } from "@/queue";

export const dynamic = "force-dynamic";

export async function GET() {
  const checks: { database: boolean; redis: boolean | "not configured"; databaseError?: string } = { database: false, redis: queuesAvailable() ? false : "not configured" };
  try {
    await db().execute(sql`select 1`);
    checks.database = true;
  } catch (err) {
    // The reason, with any credential stripped, so a hosted deployment can be diagnosed from outside.
    checks.databaseError = (err instanceof Error ? err.message : String(err)).replace(///[^@s]+@/g, "//<redacted>@").slice(0, 200);
  }
  if (queuesAvailable()) {
    try {
      checks.redis = (await redis().ping()) === "PONG";
    } catch {
      // reported below
    }
  }
  const ok = checks.database && checks.redis !== false;
  return Response.json({ ok, ...checks }, { status: ok ? 200 : 503 });
}
