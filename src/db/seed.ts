import { count } from "drizzle-orm";
import { hashPassword } from "@/lib/auth/password";
import { closeDb, db } from "./index";
import { users } from "./schema";

/**
 * Creates the first admin from ADMIN_EMAIL / ADMIN_PASSWORD when the users table is empty.
 * Deliberately seeds nothing else: no sample dealerships, scores or evidence.
 */
export async function seedAdmin(): Promise<"created" | "exists" | "skipped"> {
  const [row] = await db().select({ n: count() }).from(users);
  if ((row?.n ?? 0) > 0) return "exists";
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return "skipped";
  if (password.length < 12) throw new Error("ADMIN_PASSWORD must be at least 12 characters");
  await db().insert(users).values({ email, name: "Administrator", passwordHash: hashPassword(password), role: "ADMIN" });
  return "created";
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("src/db/seed.ts")) {
  seedAdmin()
    .then((r) => console.log(`Admin seed: ${r}`))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
