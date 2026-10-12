/**
 * Runs a TypeScript script with the same environment scripts/dev-local.mjs gives the app, so
 * command-line checks talk to the running dev database and queue.
 *
 *   node scripts/with-dev-env.mjs scripts/agent-check.ts status
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The app loads .env on start (scripts/dev-local.mjs); the command-line tools need the same values.
if (existsSync(path.join(process.cwd(), ".env"))) process.loadEnvFile(path.join(process.cwd(), ".env"));

const dataDir = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share"), "dealer-intel");
const credFile = path.join(process.cwd(), ".data", "dev-credentials.txt");
const creds = existsSync(credFile) ? Object.fromEntries(readFileSync(credFile, "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])) : {};
const PG_PORT = process.env.DEV_PG_PORT ?? "54330";
const REDIS_PORT = process.env.DEV_REDIS_PORT ?? "63790";
const env = {
  ...process.env,
  NODE_ENV: "development",
  APP_URL: `http://localhost:${process.env.PORT ?? "5310"}`,
  DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/dealer_intel`,
  REDIS_URL: `redis://127.0.0.1:${REDIS_PORT}`,
  STORAGE_DRIVER: process.env.STORAGE_DRIVER ?? "local",
  STORAGE_LOCAL_DIR: process.env.STORAGE_LOCAL_DIR ?? path.join(dataDir, "evidence"),
  ALLOW_LOCAL_TARGETS: "true",
  ...creds,
};
const [script, ...args] = process.argv.slice(2);
const child = spawn("npx", ["tsx", script, ...args], { stdio: "inherit", shell: true, env });
child.on("exit", (code) => process.exit(code ?? 0));
