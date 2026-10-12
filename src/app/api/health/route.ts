import { sql } from "drizzle-orm";
import { db } from "@/db";
import { queuesAvailable, redis } from "@/queue";

export const dynamic = "force-dynamic";

export async function GET() {
  const checks: { database: boolean; redis: boolean | "not configured" } = { database: false, redis: queuesAvailable() ? false : "not configured" };
  try {
    await db().execute(sql`select 1`);
    checks.database = true;
  } catch {
    // reported below
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
