import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, db } from "./index";

export async function runMigrations(): Promise<void> {
  await migrate(db(), { migrationsFolder: "./drizzle" });
}

// `tsx src/db/migrate.ts`
if (process.argv[1]?.replace(/\\/g, "/").endsWith("src/db/migrate.ts")) {
  runMigrations()
    .then(() => console.log("Migrations applied."))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
