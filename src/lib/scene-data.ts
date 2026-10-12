import { and, count, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { dealerships, findings, responses, salesBriefs, scores, signals, socialObservations, testInteractions, transcriptMessages, websiteObservations } from "@/db/schema";
import { agentForQueue, type AgentKey } from "@/domain/agents";
import { QUEUES, RECEPTIONIST_LABEL } from "@/domain/constants";
import type { CharlieDealership } from "@/components/agents/types";
import { describeWindow, isWithinWindow } from "@/domain/research-window";
import type { SceneData } from "@/components/agents/types";
import { getSettings } from "@/lib/settings";
import { getQueue } from "@/queue";

/** The facts a scene draws with: the latest stored records for that agent's work. Never invented. */
export async function sceneData(key: AgentKey, now = new Date()): Promise<SceneData> {
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  switch (key) {
    case "nova": {
      const [row] = await db().select({ o: websiteObservations, name: dealerships.name, url: dealerships.website }).from(websiteObservations).innerJoin(dealerships, eq(dealerships.id, websiteObservations.dealershipId)).orderBy(desc(websiteObservations.timestamp)).limit(1);
      return {
        kind: "nova",
        site: row
          ? { dealershipName: row.name, url: row.url, chatVendor: row.o.chatVendor, chatPresent: row.o.websiteStatus === "OK" ? row.o.chatPresent : null, leadFormCount: row.o.websiteStatus === "OK" ? row.o.leadFormCount : null, inventoryCount: row.o.inventoryCount, serviceMode: row.o.service?.schedulerMode ?? (row.o.servicePagePresent ? "PAGE_ONLY" : null), mobileFriendly: row.o.mobileFriendly, websiteStatus: row.o.websiteStatus, scannedAt: row.o.timestamp.toISOString() }
          : null,
      };
    }
    case "charlie": {
      const [t] = await db().select({ i: testInteractions, name: dealerships.name }).from(testInteractions).innerJoin(dealerships, eq(dealerships.id, testInteractions.dealershipId)).where(inArray(testInteractions.status, ["RUNNING", "MONITORING", "COMPLETED", "FAILED", "BLOCKED", "APPROVED"])).orderBy(desc(testInteractions.createdAt)).limit(1);
      const lines = t ? await db().select().from(transcriptMessages).where(eq(transcriptMessages.interactionId, t.i.id)).orderBy(transcriptMessages.timestamp).limit(14) : [];
      return {
        kind: "charlie",
        recent: await charlieRecent(),
        test: t ? { id: t.i.id, dealershipName: t.name, testType: t.i.testType, status: t.i.status, submittedAt: t.i.submittedAt?.toISOString() ?? null, firstResponseSeconds: t.i.firstResponseSeconds } : null,
        transcript: lines.map((l) => ({ speaker: l.speaker, message: l.message, at: l.timestamp.toISOString() })),
      };
    }
    case "sage": {
      const rows = await db().select({ s: socialObservations, name: dealerships.name }).from(socialObservations).innerJoin(dealerships, eq(dealerships.id, socialObservations.dealershipId)).orderBy(desc(socialObservations.observedAt)).limit(6);
      return { kind: "sage", cards: rows.map(({ s, name }) => ({ id: s.id, dealershipName: name, platform: s.platform, followers: s.followers, posts: s.totalPosts ?? s.postsLast30Days, questions: s.customerQuestions, unanswered: s.unansweredQuestions, note: s.notes, at: s.observedAt.toISOString() })) };
    }
    case "hunter": {
      const rows = await db().select({ s: signals, name: dealerships.name }).from(signals).leftJoin(dealerships, eq(dealerships.id, signals.dealershipId)).orderBy(desc(signals.detectedAt)).limit(8);
      return { kind: "hunter", signals: rows.map(({ s, name }) => ({ id: s.id, dealershipName: name, title: s.title, type: s.type, at: s.detectedAt.toISOString() })) };
    }
    case "atlas": {
      const [latest] = await db().select({ dealershipId: scores.dealershipId }).from(scores).orderBy(desc(scores.computedAt)).limit(1);
      if (!latest) return { kind: "atlas", target: null };
      const [[d], own, f] = await Promise.all([
        db().select({ name: dealerships.name, priority: dealerships.priorityScore, recommended: dealerships.recommendedProduct }).from(dealerships).where(eq(dealerships.id, latest.dealershipId)),
        db().select({ product: scores.product, score: scores.score }).from(scores).where(eq(scores.dealershipId, latest.dealershipId)),
        db().select({ kind: findings.kind, n: count() }).from(findings).where(eq(findings.dealershipId, latest.dealershipId)).groupBy(findings.kind),
      ]);
      if (!d) return { kind: "atlas", target: null };
      return { kind: "atlas", target: { dealershipName: d.name, priority: d.priority, recommended: d.recommended, scores: own.map((s) => ({ product: s.product, score: s.score })), observed: Number(f.find((x) => x.kind === "OBSERVED")?.n ?? 0), inferred: Number(f.find((x) => x.kind === "INFERENCE")?.n ?? 0) } };
    }
    case "blaze": {
      const [b] = await db().select({ b: salesBriefs, name: dealerships.name }).from(salesBriefs).innerJoin(dealerships, eq(dealerships.id, salesBriefs.dealershipId)).orderBy(desc(salesBriefs.generatedAt)).limit(1);
      return {
        kind: "blaze",
        brief: b ? { dealershipName: b.name, priority: b.b.priorityScore, product: b.b.recommendedProduct, mainProblem: b.b.mainProblem, salesAngle: b.b.salesAngle, opener: b.b.coldCallOpener, question: b.b.discoveryQuestion, nextAction: b.b.nextAction, claims: b.b.claims.map((c) => ({ text: c.text, kind: c.kind })), generatedAt: b.b.generatedAt.toISOString() } : null,
      };
    }
    case "orion": {
      const settings = await getSettings();
      const cfg = { enabled: settings.researchWindowEnabled, start: settings.researchWindowStart, end: settings.researchWindowEnd, timezone: settings.timezone };
      const queues = await Promise.all(
        QUEUES.map(async (q) => {
          const queue = getQueue(q);
          const [c, paused] = await Promise.all([queue.getJobCounts("waiting", "active", "delayed", "prioritized"), queue.isPaused()]);
          return { queue: q, agent: agentForQueue(q), waiting: (c.waiting ?? 0) + (c.prioritized ?? 0), active: c.active ?? 0, delayed: c.delayed ?? 0, paused };
        }),
      );
      return { kind: "orion", queues, window: { open: isWithinWindow(now, cfg), label: describeWindow(cfg) } };
    }
    case "echo": {
      const [open, byChannel] = await Promise.all([
        db().select({ i: testInteractions, name: dealerships.name }).from(testInteractions).innerJoin(dealerships, eq(dealerships.id, testInteractions.dealershipId)).where(eq(testInteractions.status, "MONITORING")).orderBy(desc(testInteractions.submittedAt)).limit(6),
        db().select({ channel: responses.channel, n: count() }).from(responses).where(gte(responses.receivedAt, weekAgo)).groupBy(responses.channel),
      ]);
      const channels = { EMAIL: 0, SMS: 0, PHONE: 0, CHAT: 0 };
      for (const r of byChannel) if (r.channel in channels) channels[r.channel as keyof typeof channels] = Number(r.n);
      return { kind: "echo", open: open.filter((o) => o.i.submittedAt).map(({ i, name }) => ({ id: i.id, dealershipName: name, testType: i.testType, submittedAt: i.submittedAt!.toISOString(), firstResponseSeconds: i.firstResponseSeconds })), channels };
    }
    case "sentinel": {
      const [rows, [total], [estimated]] = await Promise.all([
        db()
          .select({ id: dealerships.id, name: dealerships.name, unitsLow: dealerships.estUnitsLow, unitsHigh: dealerships.estUnitsHigh, grossLow: dealerships.estGrossLow, grossHigh: dealerships.estGrossHigh, profitLow: dealerships.estProfitLow, profitHigh: dealerships.estProfitHigh, profitPerUnit: dealerships.estProfitPerUnit, segment: dealerships.estSegment, method: dealerships.estMethod, confidence: dealerships.estConfidence, onHand: dealerships.inventoryCount, at: dealerships.estAt })
          .from(dealerships)
          .where(and(eq(dealerships.suppressed, false), isNotNull(dealerships.estUnitsLow)))
          .orderBy(desc(dealerships.estAt))
          .limit(10),
        db().select({ n: count() }).from(dealerships).where(eq(dealerships.suppressed, false)),
        db().select({ n: count() }).from(dealerships).where(and(eq(dealerships.suppressed, false), isNotNull(dealerships.estUnitsLow))),
      ]);
      return {
        kind: "sentinel",
        coverage: { estimated: Number(estimated?.n ?? 0), total: Number(total?.n ?? 0) },
        latest: rows.map((r) => ({ dealershipId: r.id, dealershipName: r.name, unitsLow: r.unitsLow!, unitsHigh: r.unitsHigh!, grossLow: r.grossLow, grossHigh: r.grossHigh, profitLow: r.profitLow, profitHigh: r.profitHigh, profitPerUnit: r.profitPerUnit, segment: r.segment, method: r.method ?? "LOT_SIZE", confidence: r.confidence ?? "LOW", onHand: r.onHand, at: r.at?.toISOString() ?? "" })),
      };
    }
  }
}

/** The last dealerships Charlie worked, newest first: the phone verdict and what was heard, and the chat test with its grade and lines. */
async function charlieRecent(limit = 8): Promise<CharlieDealership[]> {
  const [called, chats] = await Promise.all([
    db()
      .select({ id: dealerships.id, name: dealerships.name, receptionist: dealerships.receptionist, note: dealerships.receptionistNote, heard: dealerships.receptionistTranscript, at: dealerships.receptionistCheckedAt })
      .from(dealerships)
      .where(sql`${dealerships.receptionistCheckedAt} is not null`)
      .orderBy(desc(dealerships.receptionistCheckedAt))
      .limit(limit),
    db()
      .select({ i: testInteractions, name: dealerships.name })
      .from(testInteractions)
      .innerJoin(dealerships, eq(dealerships.id, testInteractions.dealershipId))
      .where(and(eq(testInteractions.testType, "CHAT"), inArray(testInteractions.status, ["RUNNING", "MONITORING", "COMPLETED", "FAILED", "BLOCKED"])))
      .orderBy(desc(testInteractions.createdAt))
      .limit(limit),
  ]);
  const chatIds = chats.map((c) => c.i.id);
  const dealerIds = [...new Set([...called.map((c) => c.id), ...chats.map((c) => c.i.dealershipId)])];
  const [lines, grades] = await Promise.all([
    chatIds.length ? db().select().from(transcriptMessages).where(inArray(transcriptMessages.interactionId, chatIds)).orderBy(transcriptMessages.timestamp) : [],
    dealerIds.length ? db().select({ dealershipId: websiteObservations.dealershipId, grade: websiteObservations.chatGrade, score: websiteObservations.chatQuality, at: websiteObservations.timestamp }).from(websiteObservations).where(inArray(websiteObservations.dealershipId, dealerIds)).orderBy(desc(websiteObservations.timestamp)) : [],
  ]);
  const gradeOf = new Map<string, { grade: string | null; score: number | null }>();
  for (const g of grades) if (!gradeOf.has(g.dealershipId)) gradeOf.set(g.dealershipId, { grade: g.grade, score: g.score });
  const out = new Map<string, CharlieDealership>();
  for (const c of called) {
    out.set(c.id, { dealershipId: c.id, dealershipName: c.name, at: c.at!.toISOString(), call: { verdict: RECEPTIONIST_LABEL[c.receptionist], note: c.note, heard: c.heard, at: c.at!.toISOString() }, chat: null });
  }
  for (const { i, name } of chats) {
    const at = (i.submittedAt ?? i.createdAt).toISOString();
    const row = out.get(i.dealershipId) ?? { dealershipId: i.dealershipId, dealershipName: name, at, call: null, chat: null };
    if (row.chat) continue; // newest chat per dealership only
    const g = gradeOf.get(i.dealershipId);
    row.chat = { grade: g?.grade ?? null, score: g?.score ?? null, status: i.status, firstResponseSeconds: i.firstResponseSeconds, at, lines: lines.filter((l) => l.interactionId === i.id).map((l) => ({ speaker: l.speaker, message: l.message })) };
    if (at > row.at) row.at = at;
    out.set(i.dealershipId, row);
  }
  return [...out.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
