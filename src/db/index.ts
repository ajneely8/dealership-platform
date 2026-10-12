import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

// Reuse one pool across Next.js dev hot reloads.
const globalForDb = globalThis as unknown as { __diPool?: Pool; __diDb?: Db };

export function getPool(): Pool {
  if (!globalForDb.__diPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    // Opening a Postgres connection is expensive (hundreds of ms on Windows, where each one is a new
    // process), so connections are kept alive for a long time and a few are held open permanently.
    // 30 connections: nine agents' live status, the event stream, page renders and the workers all
    // query at once; with fewer, requests queue up and time out while the database itself sits idle.
    globalForDb.__diPool = new Pool({ connectionString: url, max: 30, min: 3, idleTimeoutMillis: 30 * 60_000, keepAlive: true, connectionTimeoutMillis: 30_000 });
  }
  return globalForDb.__diPool;
}

export function db(): Db {
  if (!globalForDb.__diDb) globalForDb.__diDb = drizzle(getPool(), { schema });
  return globalForDb.__diDb;
}

export async function closeDb(): Promise<void> {
  await globalForDb.__diPool?.end();
  globalForDb.__diPool = undefined;
  globalForDb.__diDb = undefined;
}

export { schema };
