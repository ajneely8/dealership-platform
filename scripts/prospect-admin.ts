/**
 * Prospecting admin:
 *   npm run prospect-admin -- demote <domain>   remove an auto-admitted dealership and mark its candidate rejected
 *   npm run prospect-admin -- stats             pool / admitted / rejected counts
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { dealerships, prospects } from "@/db/schema";
import { closeQueues } from "@/queue";
import { demoteIfUnresearchable, isFranchise, prospectStats, unstickScreenings } from "@/workers/prospect";

async function main() {
  const [what, target] = process.argv.slice(2);
  if (what === "stats") {
    console.log(await prospectStats());
    return;
  }
  if (what === "demote" && target) {
    const [d] = await db().select({ id: dealerships.id, name: dealerships.name }).from(dealerships).where(eq(dealerships.normalizedDomain, target)).limit(1);
    if (!d) throw new Error(`no dealership with domain ${target}`);
    const done = await demoteIfUnresearchable(d.id, "", "removed by the operator");
    console.log(done ? `removed ${d.name}` : `${d.name} was not auto-admitted; left alone`);
    return;
  }
  if (what === "remove" && target) {
    const [d] = await db().select({ id: dealerships.id, name: dealerships.name }).from(dealerships).where(eq(dealerships.normalizedDomain, target)).limit(1);
    if (!d) throw new Error(`no dealership with domain ${target}`);
    await db().delete(dealerships).where(eq(dealerships.id, d.id));
    await db().update(prospects).set({ status: "REJECTED", reason: "a manufacturer franchise store — not a target", dealershipId: null }).where(eq(prospects.normalizedDomain, target));
    console.log(`removed ${d.name} and everything recorded for it`);
    return;
  }
  if (what === "requeue-blocked") {
    // Candidates turned away because the site refused the headless browser get another look
    // under the current research presentation.
    const { like, or } = await import("drizzle-orm");
    const rows = await db().update(prospects).set({ status: "NEW", reason: null, screenedAt: null }).where(or(like(prospects.reason, "%blocks automated%"), like(prospects.reason, "%could not be read (HTTP 403%"))!).returning({ id: prospects.id });
    console.log(`${rows.length} candidate(s) back in line`);
    return;
  }
  if (what === "reset-chat" && target) {
    // Remove every chat test (and its replies, transcript and screenshots) for a dealership, and clear the chat verdict.
    const { testInteractions, websiteObservations } = await import("@/db/schema");
    const [d] = await db().select({ id: dealerships.id, name: dealerships.name }).from(dealerships).where(eq(dealerships.normalizedDomain, target)).limit(1);
    if (!d) throw new Error(`no dealership with domain ${target}`);
    const { and } = await import("drizzle-orm");
    const gone = await db().delete(testInteractions).where(and(eq(testInteractions.dealershipId, d.id), eq(testInteractions.testType, "CHAT"))).returning({ id: testInteractions.id });
    await db().update(websiteObservations).set({ chatWorking: null, contactRequired: null }).where(eq(websiteObservations.dealershipId, d.id));
    console.log(`removed ${gone.length} chat test(s) for ${d.name}`);
    return;
  }
  if (what === "identities") {
    const { testIdentities } = await import("@/db/schema");
    const rows = await db().select().from(testIdentities);
    for (const i of rows) console.log(`${i.active ? "active  " : "inactive"} ${i.id} ${i.name} · ${i.email} · ${i.phone}`);
    if (rows.length === 0) console.log("(no test identities)");
    return;
  }
  if (what === "list") {
    const ds = await db().select({ id: dealerships.id, name: dealerships.name, domain: dealerships.normalizedDomain, created: dealerships.createdAt }).from(dealerships);
    const ps = await db().select({ dealershipId: prospects.dealershipId, status: prospects.status, name: prospects.name, domain: prospects.normalizedDomain }).from(prospects);
    for (const d of ds) {
      const pr = ps.find((x) => x.dealershipId === d.id);
      console.log(`${(pr ? "auto  " : "manual")}  ${String(d.domain).padEnd(32)} ${d.name}${isFranchise({ name: d.name, domain: d.domain }) ? "  [franchise]" : ""}`);
    }
    return;
  }
  if (what === "unstick") {
    console.log(`reset ${await unstickScreenings()} screening(s)`);
    return;
  }
  if (what === "purge-franchise") {
    const rows = await db().select().from(prospects).where(eq(prospects.status, "ADMITTED"));
    let n = 0;
    for (const p of rows) {
      if (!p.dealershipId || !isFranchise({ name: p.name, domain: p.normalizedDomain })) continue;
      const done = await demoteIfUnresearchable(p.dealershipId, "", "a manufacturer franchise store — not a target");
      if (done) {
        await db().update(prospects).set({ reason: "a manufacturer franchise store — not a target" }).where(eq(prospects.id, p.id));
        console.log(`removed ${p.name}`);
        n += 1;
      }
    }
    const waiting = await db().select().from(prospects).where(eq(prospects.status, "NEW"));
    let m = 0;
    for (const p of waiting) {
      if (!isFranchise({ name: p.name, domain: p.normalizedDomain })) continue;
      await db().update(prospects).set({ status: "REJECTED", reason: "a manufacturer franchise store — not a target", screenedAt: new Date() }).where(eq(prospects.id, p.id));
      m += 1;
    }
    console.log(`${n} franchise store(s) removed, ${m} franchise candidate(s) dropped from the pool`);
    return;
  }
  console.error("usage: prospect-admin stats | demote <domain> | purge-franchise");
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
