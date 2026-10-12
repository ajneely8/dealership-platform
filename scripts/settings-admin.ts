/**
 * Settings from the command line (same table the Settings page writes):
 *   npm run settings-admin -- get
 *   npm run settings-admin -- set chatTestMode auto
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { settings as settingsTable } from "@/db/schema";
import { closeQueues } from "@/queue";
import { getSettings, settingsSchema } from "@/lib/settings";

async function main() {
  const [what, key, value] = process.argv.slice(2);
  if (what === "get") {
    const s = await getSettings();
    for (const [k, v] of Object.entries(s)) if (typeof v !== "object") console.log(`${k} = ${String(v)}`);
    return;
  }
  if (what === "set" && key && value !== undefined) {
    const current = await getSettings();
    const field = settingsSchema.shape[key as keyof typeof settingsSchema.shape];
    if (!field) throw new Error(`unknown setting ${key}`);
    const parsed = field.parse(value === "true" ? true : value === "false" ? false : /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value);
    const [existing] = await db().select({ key: settingsTable.key }).from(settingsTable).where(eq(settingsTable.key, key)).limit(1);
    if (existing) await db().update(settingsTable).set({ value: parsed as never, updatedAt: new Date(), updatedBy: "cli" }).where(eq(settingsTable.key, key));
    else await db().insert(settingsTable).values({ key, value: parsed as never, updatedBy: "cli" });
    console.log(`${key}: ${String((current as Record<string, unknown>)[key])} → ${String(parsed)}`);
    return;
  }
  console.error("usage: settings-admin get | set <key> <value>");
  process.exit(2);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueues().catch(() => undefined);
    setTimeout(() => process.exit(), 200).unref();
  });
