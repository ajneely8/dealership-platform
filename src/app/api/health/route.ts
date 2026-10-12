import { sql } from "drizzle-orm";
import { db } from "@/db";
import { redis } from "@/queue";

export const dynamic = "force-dynamic";

export async function GET() {
  const checks = { database: false, redis: false };
  try {
    await db().execute(sql`select 1`);
    checks.database = true;
  } catch {
    // reported below
  }
  try {
    checks.redis = (await redis().ping()) === "PONG";
  } catch {
    // reported below
  }
  const ok = checks.database && checks.redis;
  return Response.json({ ok, ...checks }, { status: ok ? 200 : 503 });
}
