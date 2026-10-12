import { closeDb } from "@/db";
import { env } from "@/env";
import { logger } from "@/lib/logger";
import { closeQueues } from "@/queue";
import { startWorkers } from "./runner";
import { startScheduler } from "./scheduler";

// Worker process entry point: `npm run workers`. Runs every queue's worker plus the scheduler.
env(); // fail fast on bad configuration
const workers = startWorkers();
const stopScheduler = startScheduler();
logger.info({ queues: workers.map((w) => w.name) }, "workers started");

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  logger.info({ signal }, "shutting down workers");
  stopScheduler();
  // close() waits for in-flight jobs, so a form submission is never cut off halfway.
  await Promise.allSettled(workers.map((w) => w.close()));
  await closeQueues();
  await closeDb();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
