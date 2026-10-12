/**
 * Sets a dashboard user's password.
 *   npx tsx scripts/set-password.ts <email> <new-password>
 * Needs DATABASE_URL (for local dev: postgres://postgres:postgres@127.0.0.1:54330/dealer_intel).
 */
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { hashPassword } from "@/lib/auth/password";

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error("Usage: npx tsx scripts/set-password.ts <email> <new-password>");
  process.exit(1);
}

const [row] = await db()
  .update(users)
  .set({ passwordHash: hashPassword(password) })
  .where(eq(users.email, email.toLowerCase()))
  .returning({ id: users.id });
if (!row) {
  console.error(`No user with email ${email}`);
  process.exitCode = 1;
} else {
  await audit("system:cli", "user.created", "user", row.id, { passwordReset: true });
  console.log(`Password updated for ${email}`);
}
await closeDb();
