/**
 * Single-container start (Railway and similar hosts): apply migrations, seed the first admin if the
 * users table is empty, then run the dashboard and the agents side by side. If either process
 * stops, the container stops, and the host's restart policy brings it back.
 *
 *   node scripts/start-all.mjs
 *
 * Environment: everything in .env.example; the host sets PORT. Evidence goes to STORAGE_LOCAL_DIR
 * (a mounted volume) when STORAGE_DRIVER=local.
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";

const port = process.env.PORT || "5310";
const log = (m) => console.log(`[start] ${new Date().toISOString()} ${m}`);

function run(cmd, args, name) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", env: process.env });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${name} exited with code ${code}`))));
    p.on("error", reject);
  });
}

if (process.env.STORAGE_DRIVER === "local" && process.env.STORAGE_LOCAL_DIR) {
  await mkdir(process.env.STORAGE_LOCAL_DIR, { recursive: true });
}

log("applying migrations");
await run("npx", ["tsx", "src/db/migrate.ts"], "migrate");
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  log("seeding the first admin if the users table is empty");
  await run("npx", ["tsx", "src/db/seed.ts"], "seed");
}

log(`starting the dashboard on port ${port} and the agents`);
const web = spawn("npx", ["next", "start", "-p", port], { stdio: "inherit", env: process.env });
const workers = spawn("npx", ["tsx", "src/workers/index.ts"], { stdio: "inherit", env: process.env });

let stopping = false;
function stop(signal, code = 0) {
  if (stopping) return;
  stopping = true;
  log(`stopping (${signal})`);
  for (const p of [web, workers]) if (p.exitCode === null) p.kill("SIGTERM");
  setTimeout(() => process.exit(code), 15_000).unref();
}
web.on("exit", (code) => stop(`dashboard exited with ${code}`, code ?? 1));
workers.on("exit", (code) => stop(`agents exited with ${code}`, code ?? 1));
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
