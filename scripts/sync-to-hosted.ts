/**
 * Copy the research data from the local database to a hosted one (the Vercel viewer's Postgres).
 *
 *   npm run sync-to-hosted            applies migrations on the target, then copies every table
 *   npm run sync-to-hosted -- --dry   lists tables and row counts, copies nothing
 *
 * The target is TARGET_DATABASE_URL in .env (the hosted connection string). Rows already present
 * on the target are left alone (ON CONFLICT DO NOTHING on the primary key), so the sync can be run
 * again any time to push new research up. Sessions and the relay baton are not copied.
 *
 * Needs the local dev stack running (npm run fast / dev) so the local database answers.
 */
import { Pool } from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";

const SKIP = new Set(["sessions", "__drizzle_migrations"]);
const BATCH = 200;

type Col = { name: string; type: string };

async function tablesInOrder(pool: Pool): Promise<string[]> {
  const t = await pool.query<{ table_name: string }>(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`);
  const fk = await pool.query<{ child: string; parent: string }>(`
    select tc.table_name as child, ccu.table_name as parent
    from information_schema.table_constraints tc
    join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.constraint_schema = tc.constraint_schema
    where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'`);
  const names = t.rows.map((r) => r.table_name).filter((n) => !SKIP.has(n));
  const parents = new Map<string, Set<string>>();
  for (const n of names) parents.set(n, new Set());
  for (const r of fk.rows) if (r.child !== r.parent && parents.has(r.child) && parents.has(r.parent)) parents.get(r.child)!.add(r.parent);
  // Kahn's algorithm: parents before children.
  const out: string[] = [];
  const done = new Set<string>();
  while (out.length < names.length) {
    const ready = names.filter((n) => !done.has(n) && [...parents.get(n)!].every((p) => done.has(p)));
    if (!ready.length) throw new Error(`circular foreign keys among: ${names.filter((n) => !done.has(n)).join(", ")}`);
    for (const n of ready) {
      out.push(n);
      done.add(n);
    }
  }
  return out;
}

async function columns(pool: Pool, table: string): Promise<Col[]> {
  const r = await pool.query<{ column_name: string; data_type: string }>(`select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`, [table]);
  return r.rows.map((c) => ({ name: c.column_name, type: c.data_type }));
}

async function primaryKey(pool: Pool, table: string): Promise<string[]> {
  const r = await pool.query<{ column_name: string }>(`
    select kcu.column_name from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
    where tc.table_schema = 'public' and tc.table_name = $1 and tc.constraint_type = 'PRIMARY KEY' order by kcu.ordinal_position`, [table]);
  return r.rows.map((x) => x.column_name);
}

async function main() {
  const dry = process.argv.includes("--dry");
  const source = process.env.DATABASE_URL;
  const target = process.env.TARGET_DATABASE_URL;
  if (!source) throw new Error("DATABASE_URL (local) is not set; run through scripts/with-dev-env.mjs");
  if (!target && !dry) throw new Error("TARGET_DATABASE_URL is not set; add the hosted connection string to .env");
  const src = new Pool({ connectionString: source, max: 2 });
  const dst = target ? new Pool({ connectionString: target, max: 2, ssl: /sslmode=require|neon\.tech|vercel|supabase|railway/i.test(target) ? { rejectUnauthorized: false } : undefined }) : null;
  try {
    if (!dry && dst) {
      console.log("applying migrations on the target…");
      await migrate(drizzle(dst), { migrationsFolder: "./drizzle" });
    }
    const order = await tablesInOrder(src);
    let total = 0;
    for (const table of order) {
      const cols = await columns(src, table);
      const pk = await primaryKey(src, table);
      const { rows } = await src.query(`select * from "${table}"${table === "settings" ? ` where key <> 'relay'` : ""}`);
      console.log(`${table.padEnd(24)} ${String(rows.length).padStart(6)} row(s)${dry ? "" : " → copying"}`);
      if (dry || !dst || rows.length === 0) continue;
      const names = cols.map((c) => `"${c.name}"`).join(", ");
      const conflict = pk.length ? ` on conflict (${pk.map((c) => `"${c}"`).join(", ")}) do nothing` : "";
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        const values: unknown[] = [];
        const tuples = chunk.map((row, r) => `(${cols.map((c, k) => {
          const v = (row as Record<string, unknown>)[c.name];
          values.push(c.type === "jsonb" || c.type === "json" ? (v === null ? null : JSON.stringify(v)) : v);
          return `$${r * cols.length + k + 1}${c.type === "jsonb" ? "::jsonb" : c.type === "json" ? "::json" : ""}`;
        }).join(", ")})`);
        await dst.query(`insert into "${table}" (${names}) values ${tuples.join(", ")}${conflict}`, values);
        total += chunk.length;
      }
    }
    console.log(dry ? "dry run: nothing copied" : `done: ${total} row(s) offered to the target (existing rows left untouched)`);
  } finally {
    await src.end();
    await dst?.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
