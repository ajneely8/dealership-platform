/**
 * Phone-check admin:
 *   npm run phone-admin -- status                 is Twilio configured, which number, trial or not
 *   npm run phone-admin -- test-call +1XXXXXXXXXX  Charlie calls that number with the configured script
 *                                                 and reports rings, what answered and the verdict
 *                                                 (no dealership record is touched)
 */
import { env } from "@/env";
import { classifyPhoneAnswer } from "@/domain/phone-answer";
import { getSettings } from "@/lib/settings";
import { placeScriptedCall, twilioConfigured } from "@/lib/telephony";

async function main() {
  const [what, target] = process.argv.slice(2);
  if (what === "status") {
    const e = env();
    if (!twilioConfigured()) {
      console.log("Twilio: not configured");
      return;
    }
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${e.TWILIO_ACCOUNT_SID}.json`, { headers: { authorization: "Basic " + Buffer.from(`${e.TWILIO_ACCOUNT_SID}:${e.TWILIO_AUTH_TOKEN}`).toString("base64") } });
    const j = (await res.json()) as { friendly_name?: string; status?: string; type?: string; message?: string };
    console.log(`Twilio: ${j.message ? `error — ${j.message}` : `${j.friendly_name} · ${j.status} · ${j.type}`} · calling from ${e.TWILIO_FROM_NUMBER}`);
    return;
  }
  if (what === "test-call" && target) {
    if (!twilioConfigured()) throw new Error("Twilio is not configured");
    const s = await getSettings();
    console.log(`Calling ${target} and listening (hang up on human: ${s.phoneHangUpOnHuman})`);
    const call = await placeScriptedCall({ to: target, script: s.phoneCheckScript, recordSeconds: 30, hangUpOnHuman: s.phoneHangUpOnHuman });
    const verdict = classifyPhoneAnswer({ callStatus: call.status, answeredBy: call.answeredBy, transcript: call.transcript, durationSeconds: call.durationSeconds, hungUpOnHuman: call.hungUpOnHuman, rings: call.rings });
    console.log(`status: ${call.status} · answered by: ${call.answeredBy ?? "unknown"} · rings: ${call.rings ?? "?"} (${call.ringSeconds ?? "?"}s) · duration: ${call.durationSeconds ?? "?"}s · hung up on human: ${call.hungUpOnHuman}`);
    console.log(`transcript: ${call.transcript ? JSON.stringify(call.transcript) : "(none)"}`);
    console.log(`verdict: ${verdict.status} (${verdict.confidence}) — ${verdict.reason}`);
    return;
  }
  if (what === "call-all") {
    // Every dealership with a number that Charlie has not called yet: approve for testing and queue
    // one phone check each. Calls run inside research hours, a few at a time.
    const { db } = await import("@/db");
    const { dealerships } = await import("@/db/schema");
    const { enqueue, closeQueues } = await import("@/queue");
    const { and, eq, isNotNull, or, isNull, not, like } = await import("drizzle-orm");
    const rows = await db().select({ id: dealerships.id, name: dealerships.name, phone: dealerships.phone, approved: dealerships.testingApproved }).from(dealerships).where(and(isNotNull(dealerships.phone), eq(dealerships.suppressed, false), or(isNull(dealerships.receptionistCheckedBy), not(like(dealerships.receptionistCheckedBy, "system:%")))));
    let queued = 0;
    for (const d of rows) {
      if (!d.approved) await db().update(dealerships).set({ testingApproved: true, testingApprovedBy: "operator:call-all", testingApprovedAt: new Date() }).where(eq(dealerships.id, d.id));
      if ((await enqueue("phone-check", { dealershipId: d.id })).queued) queued += 1;
    }
    console.log(`${queued} phone check(s) queued for ${rows.length} dealership(s) with a number`);
    await closeQueues().catch(() => undefined);
    return;
  }
  if (what === "stop") {
    // Cancels every phone check still WAITING in the queue. A call already ringing or in progress
    // is left to finish on its own — nothing is hung up mid-conversation.
    const { getQueue, closeQueues } = await import("@/queue");
    const queue = getQueue("phone-check");
    const before = await queue.getJobCounts("waiting", "active", "delayed");
    await queue.drain(false);
    const after = await queue.getJobCounts("waiting", "active", "delayed");
    console.log(`phone-check queue: waiting ${before.waiting} → ${after.waiting}, in progress ${after.active} (left to finish), parked ${after.delayed}`);
    await closeQueues().catch(() => undefined);
    return;
  }
  console.error("usage: phone-admin status | test-call <+1number> | call-all | stop");
  process.exit(2);
}

main()
  .catch((err) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => {
    // the settings read keeps a database connection open; do not let it hold the process
    setTimeout(() => process.exit(), 200).unref();
  });
