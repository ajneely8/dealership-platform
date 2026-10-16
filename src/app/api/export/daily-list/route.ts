import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { contacts, evidence, salesBriefs, websiteObservations } from "@/db/schema";
import { PRODUCT_LABEL } from "@/domain/constants";
import { formatDuration } from "@/domain/response-timing";
import { getSessionUser } from "@/lib/auth/session";
import { listOpportunities } from "@/lib/queries";

export const dynamic = "force-dynamic";

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Today's lead list, one row per dealership, best fit first. The record format the sales team asked for. */
export async function GET() {
  if (!(await getSessionUser())) return new Response("Unauthorized", { status: 401 });
  const rows = await listOpportunities({}, 2000);
  const order = { STRONG: 0, POSSIBLE: 1, UNKNOWN: 2, WEAK: 3 } as const;
  rows.sort((a, b) => order[a.fit.tier] - order[b.fit.tier] || b.priority - a.priority);
  const ids = rows.map((r) => r.id);
  const [briefs, contactRows, shots, observations] = ids.length
    ? await Promise.all([
        db().select().from(salesBriefs).where(inArray(salesBriefs.dealershipId, ids)).orderBy(desc(salesBriefs.generatedAt)),
        db().select().from(contacts).where(inArray(contacts.dealershipId, ids)),
        db().select({ dealershipId: evidence.dealershipId, type: evidence.type }).from(evidence).where(inArray(evidence.dealershipId, ids)),
        db()
          .select({ dealershipId: websiteObservations.dealershipId, chatQuality: websiteObservations.chatQuality, chatWorking: websiteObservations.chatWorking, leadFormCount: websiteObservations.leadFormCount, websiteStatus: websiteObservations.websiteStatus })
          .from(websiteObservations)
          .where(eq(websiteObservations.websiteStatus, "OK"))
          .orderBy(desc(websiteObservations.timestamp)),
      ])
    : [[], [], [], []];
  const briefOf = new Map<string, (typeof briefs)[number]>();
  for (const b of briefs) if (!briefOf.has(b.dealershipId)) briefOf.set(b.dealershipId, b);
  const obsOf = new Map<string, (typeof observations)[number]>();
  for (const o of observations) if (!obsOf.has(o.dealershipId)) obsOf.set(o.dealershipId, o);

  const header = [
    "Dealership",
    "Group",
    "Website",
    "Location",
    "Phone",
    "Contacts (verified source on file)",
    "Fit",
    "Fit reasons",
    "Products they may need",
    "Priority score",
    "Main problem",
    "Evidence found",
    "Response time",
    "Chat quality",
    "Form quality",
    "Social activity",
    "Hiring / budget signals",
    "Recommended sales angle",
    "Cold-call opener",
    "Discovery question",
    "Screenshots / transcripts",
    "Last checked",
    "Next action",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    const b = briefOf.get(r.id);
    const o = obsOf.get(r.id);
    const own = contactRows.filter((c) => c.dealershipId === r.id);
    const shotCount = shots.filter((s) => s.dealershipId === r.id).length;
    const products = Object.entries(r.scores)
      .filter(([, v]) => (v ?? 0) > 0)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      .map(([p, v]) => `${PRODUCT_LABEL[p as keyof typeof PRODUCT_LABEL]} ${v}`)
      .join("; ");
    const chatQuality = r.checks.chatbot.answer === "NO" ? "No chatbot" : o?.chatWorking === false ? "Chatbot did not answer" : o?.chatQuality !== null && o?.chatQuality !== undefined ? `${o.chatQuality}/100` : r.checks.chatbot.answer === "YES" ? "Has chatbot, not tested" : "Unknown";
    const formQuality = !o ? "Site not read" : o.leadFormCount === 0 ? "No lead form found" : `${o.leadFormCount} lead form(s)`;
    lines.push(
      [
        r.name,
        r.groupName ?? "",
        r.domain ?? "",
        [r.city, r.state].filter(Boolean).join(", "),
        r.phone ?? "",
        own.map((c) => `${c.name}${c.title ? ` (${c.title})` : ""}${c.email ? ` ${c.email}` : ""}${c.phone ? ` ${c.phone}` : ""}`).join("; "),
        r.fit.tier,
        r.fit.reasons.join("; "),
        products,
        r.priority,
        b?.mainProblem ?? "",
        (b?.claims ?? []).map((c) => `${c.kind === "OBSERVED" ? "Observed" : "Inferred"}: ${c.text}`).join(" | "),
        r.firstResponseSeconds !== null ? formatDuration(r.firstResponseSeconds) : r.lastTestedAt ? "No response yet" : "Not tested",
        chatQuality,
        formQuality,
        r.checks.followUp.detail.startsWith("Tools seen") ? "" : "",
        r.hiring ? "Yes (see signals)" : "",
        b?.salesAngle ?? "",
        b?.coldCallOpener ?? "",
        b?.discoveryQuestion ?? "",
        shotCount ? `${shotCount} on file` : "",
        r.lastChecked ? r.lastChecked.toISOString().slice(0, 10) : "",
        r.nextAction ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  const today = new Date().toISOString().slice(0, 10);
  return new Response(`﻿${lines.join("\r\n")}\r\n`, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="sidekick-daily-list-${today}.csv"`, "cache-control": "no-store" },
  });
}
