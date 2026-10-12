import { and, desc, eq, inArray } from "drizzle-orm";
import { estimateVolume, fmtUsd, SEGMENT_LABEL, type Segment } from "@/domain/volume";
import { twilioConfigured } from "@/lib/telephony";
import { notFound } from "next/navigation";
import {
  addContact,
  addNote,
  logSalesTouch,
  approveInteraction,
  cancelInteraction,
  createSignal,
  deleteDealership,
  logChatTest,
  queueJob,
  recordManualResponse,
  recordSocial,
  requestChatTest,
  requestInteraction,
  setPaused,
  setPipeline,
  setManualChatbot,
  setPriority,
  setReceptionist,
  setTestingApproval,
  suppress,
  updateDealership,
  queuePhoneCheck,
} from "@/app/actions";
import { A, Badge, Empty, ExternalLink, Field, Flash, PageHeader, Panel, ProductTag, Provenance, ReasonBar, ScoreNumber, fmtDate, label, timeAgo } from "@/components/ui";
import { db } from "@/db";
import {
  contacts,
  dealerGroups,
  dealerships,
  evidence,
  inventorySnapshots,
  jobRuns,
  notes,
  responses,
  salesBriefs,
  scoreHistory,
  scores,
  signals,
  socialObservations,
  socialProfiles,
  testIdentities,
  testInteractions,
  transcriptMessages,
  websiteObservations,
} from "@/db/schema";
import { CHANNELS, CONFIDENCE, MILESTONES, PIPELINE_STAGES, PRODUCTS, PRODUCT_LABEL, SIGNAL_TYPES, SUBMITTABLE_FORM_TYPES, SUPPRESSION_REASONS, type EvidenceRef } from "@/domain/constants";
import { assessFit, deriveChecks } from "@/domain/checks";
import { GROWTH_SIGNAL_TYPES, RECEPTIONIST_LABEL, RECEPTIONIST_STATUSES } from "@/domain/constants";
import { CheckCards, FitBadge, SalesStatusBadge } from "@/components/checks";
import { SALES_OUTCOMES, SALES_OUTCOME_LABEL } from "@/domain/constants";
import { salesTouches } from "@/db/schema";
import { WorkStatus } from "@/components/work-status";
import { checkEligibility } from "@/domain/eligibility";
import { formatDuration } from "@/domain/response-timing";
import { hasRole, requireUser } from "@/lib/auth/session";
import { formatPhone } from "@/lib/normalize";
import { getSettings } from "@/lib/settings";
import { APPROVED_MESSAGES } from "@/domain/constants";

const REF_ANCHOR: Record<EvidenceRef["type"], string> = {
  observation: "#research",
  interaction: "#interactions",
  response: "#interactions",
  transcript: "#interactions",
  signal: "#signals",
  inventory: "#inventory",
  social: "#social",
  evidence: "#screenshots",
};
const REF_LABEL: Record<EvidenceRef["type"], string> = {
  observation: "website scan",
  interaction: "test",
  response: "response",
  transcript: "transcript",
  signal: "signal",
  inventory: "inventory snapshot",
  social: "social observation",
  evidence: "screenshot",
};

function Refs({ refs }: { refs: EvidenceRef[] }) {
  const unique = [...new Map(refs.map((r) => [r.type, r])).values()];
  return (
    <span className="text-[11.5px] text-faint">
      {unique.map((r, i) => (
        <span key={r.type}>
          {i ? ", " : ""}
          <a className="underline hover:text-text" href={REF_ANCHOR[r.type]}>
            {REF_LABEL[r.type]}
          </a>
        </span>
      ))}
    </span>
  );
}

type TimelineItem = { at: Date; text: string; tone?: "bad" | "good"; href?: string };

export default async function DealershipPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string; error?: string }> }) {
  const { id } = await params;
  const { notice, error } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const user = await requireUser();
  const [d] = await db().select().from(dealerships).where(eq(dealerships.id, id)).limit(1);
  if (!d) notFound();
  const back = `/dealerships/${id}`;
  const canOperate = hasRole(user, "OPERATOR");

  const [group, allGroups, scoreRows, [brief], observations, inventory, interactions, signalRows, shots, profiles, social, noteRows, touches, contactRows, history, identities, settings, [runningJob]] = await Promise.all([
    d.groupId ? db().select().from(dealerGroups).where(eq(dealerGroups.id, d.groupId)).limit(1) : Promise.resolve([]),
    db().select({ id: dealerGroups.id, name: dealerGroups.name }).from(dealerGroups).orderBy(dealerGroups.name),
    db().select().from(scores).where(eq(scores.dealershipId, id)),
    db().select().from(salesBriefs).where(eq(salesBriefs.dealershipId, id)).orderBy(desc(salesBriefs.generatedAt)).limit(1),
    db().select().from(websiteObservations).where(eq(websiteObservations.dealershipId, id)).orderBy(desc(websiteObservations.timestamp)).limit(5),
    db().select().from(inventorySnapshots).where(eq(inventorySnapshots.dealershipId, id)).orderBy(desc(inventorySnapshots.capturedAt)).limit(12),
    db().select().from(testInteractions).where(eq(testInteractions.dealershipId, id)).orderBy(desc(testInteractions.createdAt)).limit(20),
    db().select().from(signals).where(eq(signals.dealershipId, id)).orderBy(desc(signals.detectedAt)).limit(40),
    db().select().from(evidence).where(eq(evidence.dealershipId, id)).orderBy(desc(evidence.capturedAt)).limit(12),
    db().select().from(socialProfiles).where(eq(socialProfiles.dealershipId, id)),
    db().select().from(socialObservations).where(eq(socialObservations.dealershipId, id)).orderBy(desc(socialObservations.observedAt)).limit(10),
    db().select().from(notes).where(eq(notes.dealershipId, id)).orderBy(desc(notes.createdAt)).limit(20),
    db().select().from(salesTouches).where(eq(salesTouches.dealershipId, id)).orderBy(desc(salesTouches.createdAt)).limit(30),
    db().select().from(contacts).where(eq(contacts.dealershipId, id)).orderBy(contacts.name),
    db().select().from(scoreHistory).where(eq(scoreHistory.dealershipId, id)).orderBy(desc(scoreHistory.changedAt)).limit(30),
    db().select().from(testIdentities).where(eq(testIdentities.active, true)).orderBy(testIdentities.name),
    getSettings(),
    db().select({ id: jobRuns.id }).from(jobRuns).where(and(eq(jobRuns.dealershipId, id), eq(jobRuns.status, "RUNNING"))).limit(1),
  ]);
  const interactionIds = interactions.map((i) => i.id);
  const [responseRows, transcript] = interactionIds.length
    ? await Promise.all([
        db().select().from(responses).where(inArray(responses.interactionId, interactionIds)).orderBy(responses.receivedAt),
        db().select().from(transcriptMessages).where(inArray(transcriptMessages.interactionId, interactionIds)).orderBy(transcriptMessages.timestamp),
      ])
    : [[], []];

  const obs = observations[0];
  const okObs = observations.find((o) => o.websiteStatus === "OK");
  const submittable = (okObs?.leadForms ?? []).map((f, index) => ({ f, index })).filter(({ f }) => SUBMITTABLE_FORM_TYPES.includes(f.type) && !f.hasProhibitedFields && !f.hasCaptcha);
  const firstForm = submittable[0]?.f;
  const eligibility = await checkEligibility({ dealershipId: id, identityId: identities[0]?.id ?? null, targetUrl: firstForm?.pageUrl ?? d.website, formType: firstForm?.type ?? null, form: firstForm ?? null });

  // ---- Evidence timeline: every entry is derived from a stored record -------------
  const timeline: TimelineItem[] = [];
  for (const i of interactions) {
    if (i.submittedAt) {
      timeline.push({ at: i.submittedAt, text: i.testType === "FORM" ? `Lead submitted (${label(i.formType ?? "form")})` : "Chat test run by operator", href: "#interactions" });
      const own = responseRows.filter((r) => r.interactionId === i.id);
      if (i.testType === "FORM") {
        // Only the latest milestone that passed with no response is shown; earlier ones are implied.
        const lastMissed = MILESTONES.filter((m) => i.milestones[m.key] === false).at(-1);
        if (lastMissed) timeline.push({ at: new Date(i.submittedAt.getTime() + lastMissed.seconds * 1000), text: `No response after ${lastMissed.label}`, tone: "bad", href: "#interactions" });
        const smsInHour = own.some((r) => r.channel === "SMS" && r.responseSeconds <= 3600);
        if (!smsInHour && Date.now() - i.submittedAt.getTime() >= 3_600_000) {
          timeline.push({ at: new Date(i.submittedAt.getTime() + 3_600_000), text: "No SMS after 60 minutes", tone: "bad", href: "#interactions" });
        }
      }
    }
  }
  for (const r of responseRows) {
    const who = r.humanOrAutomation === "HUMAN" ? "Human " : r.humanOrAutomation === "AUTOMATION" ? "Automated " : "";
    timeline.push({ at: r.receivedAt, text: `${who}${r.channel === "PHONE" ? "phone call" : r.channel.toLowerCase()} received (${formatDuration(r.responseSeconds)} after submission)`, tone: "good", href: "#interactions" });
  }
  for (const h of history) {
    if (h.previous === null && h.score === 0) continue;
    const subject = h.subject === "PRIORITY" ? "Priority" : `${PRODUCT_LABEL[h.subject as keyof typeof PRODUCT_LABEL] ?? h.subject} opportunity`;
    const verb = h.previous === null ? "scored" : h.score > h.previous ? "increased to" : "decreased to";
    timeline.push({ at: h.changedAt, text: `${subject} ${verb} ${h.score}`, href: "#scores" });
  }
  for (const o of observations) timeline.push({ at: o.timestamp, text: o.websiteStatus === "OK" ? `Website scanned (${o.pages.filter((p) => p.outcome === "OK").length} pages)` : `Website scan: ${label(o.websiteStatus)}`, href: "#research" });
  for (const s of signalRows.slice(0, 10)) timeline.push({ at: s.detectedAt, text: `Signal: ${s.title}`, href: "#signals" });
  timeline.sort((a, b) => b.at.getTime() - a.at.getTime());

  const priority = d.priorityOverride ?? d.priorityScore;
  const hidden = <input type="hidden" name="back" value={back} />;

  const latestFormTest = interactions.find((i) => i.testType === "FORM" && i.submittedAt) ?? null;
  const checks = deriveChecks({
    dealership: d,
    observation: obs ?? null,
    interaction: latestFormTest,
    responses: latestFormTest ? responseRows.filter((r) => r.interactionId === latestFormTest.id) : [],
  });
  const growthHiring = signalRows.filter((s) => GROWTH_SIGNAL_TYPES.includes(s.type) && Date.now() - s.detectedAt.getTime() < 60 * 86_400_000).map((s) => s.title);
  const fit = assessFit(checks, {
    chatWorking: obs?.chatWorking ?? null,
    chatQuality: obs?.chatQuality ?? null,
    leadFormCount: obs?.websiteStatus === "OK" ? obs.leadFormCount : null,
    siteReadable: obs?.websiteStatus === "OK",
    growthHiring,
  });
  const phoneDisplay = formatPhone(d.normalizedPhone) ?? d.phone;

  return (
    <>
      <PageHeader
        title={d.name}
        sub={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {group[0] ? <A href={`/groups/${group[0].id}`}>{group[0].name}</A> : <span>Independent / no group on file</span>}
            <span>{[d.address, d.city, d.state, d.zip].filter(Boolean).join(", ") || "No address"}</span>
            {d.website ? <ExternalLink href={d.website} /> : <span>No website</span>}
            {d.normalizedPhone || d.phone ? (
              <a href={`tel:${d.normalizedPhone ? `+1${d.normalizedPhone}` : d.phone}`} className="num text-blue-light hover:underline">
                {formatPhone(d.normalizedPhone) ?? d.phone}
              </a>
            ) : (
              <span className="num">No phone</span>
            )}
            {d.brands.length ? <span>{d.brands.join(" · ")}</span> : null}
            <span>Checked {timeAgo(d.lastChecked)}</span>
          </span>
        }
      >
        <SalesStatusBadge status={d.salesStatus} at={d.lastTouchAt} />
        {d.suppressed ? <Badge tone="bad">Suppressed · {label(d.suppressionReason ?? "manual")}</Badge> : null}
        {d.paused ? <Badge tone="warn">Paused</Badge> : null}
        <Badge tone={d.testingApproved ? "good" : "neutral"}>{d.testingApproved ? "Testing approved" : "Testing not approved"}</Badge>
      </PageHeader>
      <Flash notice={notice} error={error} />
      <WorkStatus dealershipId={id} initiallyBusy={Boolean(runningJob) || Boolean(notice && / now./.test(notice))} />

      {canOperate ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {(
            [
              ["website-scan", "Run website scan"],
              ["scoring", "Re-score"],
              ["inventory", "Check inventory"],
              ["signals", "Check careers page"],
              ["sales-intel", "Rebuild brief"],
            ] as const
          ).map(([queue, text]) => (
            <form key={queue} action={queueJob}>
              {hidden}
              <input type="hidden" name="dealershipId" value={id} />
              <input type="hidden" name="queue" value={queue} />
              <button className="btn" type="submit" disabled={!d.website && queue !== "scoring" && queue !== "sales-intel"}>
                {text}
              </button>
            </form>
          ))}
          <form action={setPaused}>
            {hidden}
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="paused" value={String(!d.paused)} />
            <button className="btn" type="submit">
              {d.paused ? "Resume" : "Pause"}
            </button>
          </form>
          <form action={setTestingApproval}>
            {hidden}
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="approved" value={String(!d.testingApproved)} />
            <button className="btn" type="submit">
              {d.testingApproved ? "Disable testing" : "Approve testing"}
            </button>
          </form>
        </div>
      ) : null}

      {/* ---- The three questions ---- */}
      <Panel title="Snapshot" className="mb-4" action={<span className="num text-[11px] uppercase tracking-[0.08em] text-muted">Priority {priority} / 100</span>}>
        <CheckCards
          checks={checks}
          append={
            <div className="bg-surface px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[14px] font-semibold">Monthly sales · estimate</span>
                {d.estUnitsLow !== null ? <Badge tone={d.estConfidence === "HIGH" ? "good" : d.estConfidence === "MEDIUM" ? "warn" : "neutral"}>{d.estConfidence === "HIGH" ? "High confidence" : d.estConfidence === "MEDIUM" ? "Medium confidence" : "First guess"}</Badge> : <Badge tone="neutral">Not yet</Badge>}
              </div>
              {d.estUnitsLow !== null && d.estUnitsHigh !== null ? (
                <>
                  <p className="mt-1.5 text-[13px] leading-snug text-text">
                    <span className="num text-[17px] font-medium">about {d.estUnitsLow === d.estUnitsHigh ? d.estUnitsLow : `${d.estUnitsLow}–${d.estUnitsHigh}`}</span> vehicles sold a month
                  </p>
                  <p className="mt-0.5 text-[13px] leading-snug text-text">{d.estProfitLow !== null && d.estProfitHigh !== null ? <><span className="num text-[15px] font-medium">{fmtUsd(d.estProfitLow)} – {fmtUsd(d.estProfitHigh)}</span> gross profit a month</> : d.estPricesHidden ? "Profit not estimated: this dealer does not list prices online (Contact Dealer)" : "Profit not yet estimated: no asking prices read"}</p>
                  {d.estProfitPerUnit !== null ? <p className="mt-0.5 text-[12.5px] leading-snug text-muted">About {fmtUsd(d.estProfitPerUnit)} made per vehicle; a salesperson keeps about {fmtUsd(d.estCommissionPerUnit ?? 0)}. {d.estGrossLow !== null && d.estGrossHigh !== null ? `Sales volume ${fmtUsd(d.estGrossLow)}–${fmtUsd(d.estGrossHigh)}.` : ""}</p> : null}
                  <p className="num mt-1 text-[10.5px] uppercase tracking-[0.08em] text-faint">
                    From Sentinel · {d.estSegment ? `${SEGMENT_LABEL[d.estSegment as Segment] ?? d.estSegment} stock · ` : ""}{d.estMethod === "TURNOVER" ? "measured turnover" : "lot size"}{d.estAt ? ` · ${fmtDate(d.estAt)}` : ""} · <a href="#volume" className="text-blue-light hover:underline normal-case tracking-normal">how</a>
                  </p>
                </>
              ) : (
                <>
                  <p className="mt-1.5 text-[13px] leading-snug text-text">{d.estAt ? "The lot could not be counted on the last read." : "Sentinel has not estimated this dealership yet."}</p>
                  <p className="num mt-1 text-[10.5px] uppercase tracking-[0.08em] text-faint">From Sentinel · after the next inventory read</p>
                </>
              )}
            </div>
          }
          extra={{
            chatbot:
              canOperate && checks.chatbot.source !== "WEBSITE" ? (
                <form action={setManualChatbot} className="flex flex-wrap items-end gap-2">
                  {hidden}
                  <input type="hidden" name="id" value={id} />
                  <Field label="Looked at the site yourself? Record it" className="min-w-[160px] flex-1">
                    <select className="input" name="manualChatbot" defaultValue={d.manualChatbot ?? ""}>
                      <option value="">Not checked</option>
                      <option value="YES">Has a chatbot</option>
                      <option value="NO">No chatbot</option>
                    </select>
                  </Field>
                  <input className="input flex-1" name="note" placeholder="Note, e.g. vendor name" defaultValue={d.manualChatbotNote ?? ""} />
                  <button className="btn btn-sm" type="submit">
                    Save
                  </button>
                </form>
              ) : null,
            receptionist: canOperate ? (
              <div className="space-y-2">
              <form action={setReceptionist} className="flex flex-wrap items-end gap-2">
                {hidden}
                <input type="hidden" name="id" value={id} />
                <Field label={phoneDisplay ? `Call ${phoneDisplay}, then record what answered` : "Record what answered the phone"} className="min-w-[200px] flex-1">
                  <select className="input" name="receptionist" defaultValue={d.receptionist}>
                    {RECEPTIONIST_STATUSES.map((r) => (
                      <option key={r} value={r}>
                        {RECEPTIONIST_LABEL[r]}
                      </option>
                    ))}
                  </select>
                </Field>
                <input className="input flex-1" name="note" placeholder="Note (optional)" defaultValue={d.receptionistNote ?? ""} />
                <button className="btn btn-sm" type="submit">
                  Save
                </button>
              </form>
              {d.phone ? <PhoneCheckButton dealershipId={id} approved={d.testingApproved} /> : null}
              {d.receptionistTranscript ? (
                <blockquote className="rounded-md border border-line bg-charcoal px-3 py-2 text-[13px] leading-relaxed text-muted">
                  <span className="eyebrow block">Heard on the call</span>&ldquo;{d.receptionistTranscript}&rdquo;
                </blockquote>
              ) : null}
              </div>
            ) : null,
            followUp:
              checks.followUp.source !== "LIVE_TEST" && canOperate && okObs ? (
                <a href="#interactions" className="text-[12.5px] font-medium text-blue-deep hover:underline">
                  Run a live lead test ↓
                </a>
              ) : null,
          }}
        />
        <div className="flex flex-wrap items-start gap-3 border-t border-line px-4 py-2.5 text-[13px]">
          <FitBadge fit={fit} />
          {brief?.salesAngle && fit.tier !== "WEAK" ? <span className="max-w-3xl text-muted">{brief.salesAngle}</span> : null}
        </div>
      </Panel>


      <div className="mb-4">
        {/* ---- Interactions ---- */}
        <Panel title="Live lead test" id="interactions">
          <div className="border-b border-line-soft px-3 py-2 text-[12.5px]">
            {eligibility.eligible ? (
              <span className="text-good">Eligible for a controlled test right now.</span>
            ) : (
              <span className="text-muted">
                <span className="font-medium text-text">A test would be skipped: </span>
                {eligibility.reasons.map((r) => r.message).join(" ")}
              </span>
            )}
          </div>
          {interactions.length === 0 ? (
            <Empty>No tests have been run against this dealership.</Empty>
          ) : (
            <ul>
              {interactions.map((i) => {
                const own = responseRows.filter((r) => r.interactionId === i.id);
                const lines = transcript.filter((t) => t.interactionId === i.id);
                return (
                  <li key={i.id} className="border-b border-line-soft px-3 py-2.5 last:border-b-0">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                      <Badge tone={i.status === "MONITORING" ? "warn" : i.status === "COMPLETED" ? "good" : ["FAILED", "BLOCKED"].includes(i.status) ? "bad" : "neutral"}>{label(i.status)}</Badge>
                      <span className="font-medium">{i.testType === "FORM" ? `${label(i.formType ?? "form")} form` : "Chat (manual)"}</span>
                      <span className="num text-[12px] text-muted">{i.submittedAt ? `Submitted ${fmtDate(i.submittedAt, true)}` : `Requested ${fmtDate(i.createdAt, true)}`}</span>
                      {i.submittedAt && i.testType === "FORM" ? <span>First response: {i.firstResponseSeconds !== null ? formatDuration(i.firstResponseSeconds) : <span className="text-bad">none yet</span>}</span> : null}
                      <span className="text-[12px] text-muted">by {i.requestedBy}</span>
                      {canOperate && i.status === "PENDING_APPROVAL" ? (
                        <>
                          <form action={approveInteraction}>
                            {hidden}
                            <input type="hidden" name="id" value={i.id} />
                            <button className="btn btn-sm btn-primary" type="submit">
                              Approve and submit
                            </button>
                          </form>
                          <form action={cancelInteraction}>
                            {hidden}
                            <input type="hidden" name="id" value={i.id} />
                            <button className="btn btn-sm" type="submit">
                              Cancel
                            </button>
                          </form>
                        </>
                      ) : null}
                    </div>
                    {i.statusDetail ? <p className="mt-1 text-[12.5px] text-muted">{i.statusDetail}</p> : null}
                    {i.submittedAt && i.testType === "FORM" ? (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {MILESTONES.map((m) => {
                          const v = i.milestones[m.key];
                          return (
                            <span key={m.key} className={`num rounded-sm border px-1.5 text-[11px] ${v === true ? "border-good text-good" : v === false ? "border-bad text-bad" : "border-line text-faint"}`} title={v === undefined ? "Not reached yet" : v ? "A response had arrived by then" : "No response by then"}>
                              {m.key} {v === true ? "✓" : v === false ? "✗" : "·"}
                            </span>
                          );
                        })}
                      </div>
                    ) : null}
                    {lines.length ? (
                      <ol className="mt-2 space-y-1 border-l border-line pl-3 text-[12.5px]">
                        {lines.map((t) => (
                          <li key={t.id}>
                            <span className="num text-[11.5px] text-faint">{fmtDate(t.timestamp, true)}</span> <span className="font-medium">{label(t.speaker)}</span> <span className="text-muted">{t.channel.toLowerCase()}</span>
                            <div className="whitespace-pre-wrap">{t.message}</div>
                          </li>
                        ))}
                      </ol>
                    ) : null}
                    {own.length ? (
                      <div className="mt-2 overflow-x-auto">
                        <table className="tbl text-[12.5px]">
                          <thead>
                            <tr>
                              <th>Channel</th>
                              <th>After</th>
                              <th>Sender</th>
                              <th>Classification</th>
                              <th>Personalised</th>
                              <th>Answered</th>
                              <th>Call to action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {own.map((r) => (
                              <tr key={r.id}>
                                <td>{r.channel}</td>
                                <td className="num whitespace-nowrap">{formatDuration(r.responseSeconds)}</td>
                                <td>{r.sender ?? "—"}</td>
                                <td>
                                  {label(r.classification)} · {label(r.humanOrAutomation)}
                                  <div className="text-[11px] text-faint">by {r.classifiedBy === "AI" ? "AI" : r.classifiedBy === "RULE" ? "text rules" : "operator"}</div>
                                </td>
                                <td className="num">{r.personalizationScore ?? "—"}</td>
                                <td>{r.questionAnswered === null ? "—" : r.questionAnswered ? "Yes" : "No"}</td>
                                <td>{r.callToAction ?? "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                    {canOperate && (i.status === "MONITORING" || i.status === "COMPLETED") && i.testType === "FORM" ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-[12.5px] text-blue-deep hover:text-blue">Record a response by hand</summary>
                        <form action={recordManualResponse} className="mt-2 grid gap-2 md:grid-cols-4">
                          {hidden}
                          <input type="hidden" name="interactionId" value={i.id} />
                          <Field label="Channel">
                            <select className="input" name="channel">
                              {CHANNELS.map((c) => (
                                <option key={c}>{c}</option>
                              ))}
                            </select>
                          </Field>
                          <Field label="Received at">
                            <input className="input" type="datetime-local" name="receivedAt" required />
                          </Field>
                          <Field label="Sender">
                            <input className="input" name="sender" placeholder="Number or address" />
                          </Field>
                          <div className="flex items-end">
                            <button className="btn" type="submit">
                              Record response
                            </button>
                          </div>
                          <Field label="Message" className="md:col-span-4">
                            <textarea className="input" name="message" rows={2} />
                          </Field>
                        </form>
                      </details>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {canOperate ? (
            <div className="grid gap-px border-t border-line bg-line-soft md:grid-cols-3">
              <form action={requestInteraction} className="space-y-2 bg-surface p-3">
                {hidden}
                <input type="hidden" name="dealershipId" value={id} />
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Request a form test</div>
                {submittable.length === 0 || identities.length === 0 ? (
                  <p className="text-[12.5px] text-muted">{identities.length === 0 ? "Add a company-owned test identity in Settings first." : "The latest scan found no inquiry form that is safe to submit."}</p>
                ) : (
                  <>
                    <Field label="Form">
                      <select className="input" name="formIndex">
                        {submittable.map(({ f, index }) => (
                          <option key={index} value={index}>
                            {label(f.type)} — {new URL(f.pageUrl).pathname}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Identity">
                      <select className="input" name="identityId">
                        {identities.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name} · {t.email}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Question" hint="Only these early-stage questions can be sent.">
                      <select className="input" name="message">
                        {APPROVED_MESSAGES.map((m) => (
                          <option key={m}>{m}</option>
                        ))}
                      </select>
                    </Field>
                    <button className="btn" type="submit">
                      Request test
                    </button>
                    <p className="text-[11.5px] text-faint">Creates a request only. Nothing is sent until it is approved, and it is re-checked against suppression and the {settings.interactionCooldownDays}-day cooldown at that moment.</p>
                  </>
                )}
              </form>
              <div className="bg-surface">
              <form action={requestChatTest} className="space-y-2 p-3">
                {hidden}
                <input type="hidden" name="dealershipId" value={id} />
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Request an automated chat test</div>
                {!obs?.chatPresent || identities.length === 0 ? (
                  <p className="text-[12.5px] text-muted">{identities.length === 0 ? "Add a company-owned test identity in Settings first." : "No chat widget was found on the site, so there is nothing to test automatically."}</p>
                ) : (
                  <>
                    <Field label="Page to open" hint="Usually the homepage; a vehicle page works too.">
                      <input className="input" name="sourceUrl" defaultValue={d.website ?? ""} required />
                    </Field>
                    <Field label="Identity">
                      <select className="input" name="identityId">
                        {identities.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name} · {t.email}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Question" hint="One question only. If the chat asks for a name, email or phone first, the identity's details are used.">
                      <select className="input" name="message">
                        {APPROVED_MESSAGES.map((m) => (
                          <option key={m}>{m}</option>
                        ))}
                      </select>
                    </Field>
                    <button className="btn" type="submit">
                      Request chat test
                    </button>
                    <p className="text-[11.5px] text-faint">Opens the widget, sends the question, watches 90 seconds for a reply, and saves screenshots and the transcript. Nothing runs until approved.</p>
                  </>
                )}
              </form>
                <div id="sales" className="m-3 space-y-2.5 rounded-md border-2 p-3" style={{ borderColor: "var(--color-blue)", background: "linear-gradient(180deg, #10224a 0%, #0a1226 100%)", boxShadow: "0 0 0 1px rgba(125,211,252,0.25), 0 0 28px rgba(59,130,246,0.28)" }}>
                  <div className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.12em] text-blue-light">
                    <span aria-hidden className="status-dot-live inline-block h-2 w-2 rounded-full bg-blue" />
                    Sales log · log every call here
                  </div>
                  {canOperate ? (
                    <form action={logSalesTouch} className="space-y-2">
                      {hidden}
                      <input type="hidden" name="dealershipId" value={id} />
                      <textarea className="input" name="note" rows={2} placeholder="What happened? e.g. spoke with the GM, wants a demo Tuesday" />
                      <div className="flex flex-wrap gap-1.5">
                        {SALES_OUTCOMES.map((o) => (
                          <button key={o} className={`btn font-semibold ${o === "SOLD" || o === "BOOKED_MEETING" ? "btn-primary" : ""}`} type="submit" name="outcome" value={o}>
                            {SALES_OUTCOME_LABEL[o]}
                          </button>
                        ))}
                      </div>
                      <p className="text-[11.5px] text-faint">One click logs the outcome with the note, moves the pipeline stage, and shows on every list.</p>
                    </form>
                  ) : null}
                  {touches.length === 0 ? (
                    <p className="text-[12.5px] text-muted">Nobody has worked this dealership yet.</p>
                  ) : (
                    <ul className="-mx-3 border-t border-line">
                      {touches.map((t) => (
                        <li key={t.id} className="border-b border-line-soft px-3 py-2 text-[13px] last:border-b-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <SalesStatusBadge status={t.outcome} at={null} />
                            <span className="text-[11.5px] text-faint">
                              {t.by} · {fmtDate(t.createdAt, true)}
                            </span>
                          </div>
                          {t.note ? <div className="mt-1 whitespace-pre-wrap">{t.note}</div> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                          </div>
              </div>
              <form action={logChatTest} encType="multipart/form-data" className="space-y-2 bg-surface p-3">
                {hidden}
                <input type="hidden" name="dealershipId" value={id} />
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Log a chat test you ran by hand</div>
                <p className="text-[11.5px] text-faint">For widgets the automated test cannot drive. Run the chat yourself (max {settings.maxChatMessages} messages, approved questions only) and log it here.</p>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="When">
                    <input className="input" type="datetime-local" name="startedAt" required />
                  </Field>
                  <Field label="Page URL">
                    <input className="input" name="sourceUrl" defaultValue={d.website ?? ""} required />
                  </Field>
                  <Field label="Chat answered?">
                    <select className="input" name="chatWorking">
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </select>
                  </Field>
                  <Field label="Contact info required first?">
                    <select className="input" name="contactRequired">
                      <option value="false">No</option>
                      <option value="true">Yes</option>
                    </select>
                  </Field>
                </div>
                <Field label="Quality 0–100 (optional)">
                  <input className="input" type="number" name="chatQuality" min={0} max={100} />
                </Field>
                <Field label="Transcript" hint='One message per line, starting "me:" or "them:"'>
                  <textarea className="input num" name="transcript" rows={3} required />
                </Field>
                <Field label="Screenshots of the conversation" hint="PNG or JPEG, up to 5. These are the proof a salesperson can show.">
                  <input className="input" type="file" name="screenshots" accept="image/png,image/jpeg" multiple />
                </Field>
                <button className="btn" type="submit">
                  Log chat test
                </button>
              </form>
            </div>
          ) : null}
        </Panel>

      </div>

      <details className="group mb-4">
        <summary className="eyebrow cursor-pointer select-none list-none rounded-md border border-line bg-surface px-4 py-2.5 text-text hover:bg-paper">
          <span className="mr-2 inline-block transition-transform group-open:rotate-90">▸</span>
          Full research, scores and evidence
        </summary>
        <div className="mt-4">
      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-4">
          {/* ---- Sales brief ---- */}
          <Panel title="Sales brief" action={brief ? <span className="text-[12px] text-muted">Built {timeAgo(brief.generatedAt)}</span> : null}>
            <div className="grid gap-4 p-3 md:grid-cols-[110px_1fr]">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Priority</div>
                <div className="mt-1 flex items-baseline gap-1">
                  <ScoreNumber score={priority} size="lg" />
                  <span className="num text-[12px] text-faint">/100</span>
                </div>
                {d.priorityOverride !== null ? <div className="mt-1 text-[11.5px] text-warn">Manual (computed {d.priorityScore})</div> : null}
              </div>
              {brief && brief.recommendedProduct ? (
                <div className="min-w-0 space-y-2.5">
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px]">
                    <span>
                      <span className="text-muted">Recommended </span>
                      <ProductTag product={brief.recommendedProduct} />
                    </span>
                    {brief.secondaryProduct ? (
                      <span>
                        <span className="text-muted">Secondary </span>
                        <ProductTag product={brief.secondaryProduct} />
                      </span>
                    ) : null}
                  </div>
                  {brief.mainProblem ? <p className="text-[15px] font-medium leading-snug">{brief.mainProblem}</p> : null}
                  {brief.salesAngle ? (
                    <div className="border-l-2 border-text pl-3">
                      <p className="text-[13.5px] leading-relaxed">{brief.salesAngle}</p>
                      <p className="mt-1 text-[11.5px] text-faint">
                        {brief.angleSource === "AI" ? `Sales angle written by AI (${brief.model}) from the evidence below; numbers checked against it.` : "Sales angle from the standard template for this product. Configure an AI provider for a tailored one."}
                      </p>
                    </div>
                  ) : null}
                  <div className="grid gap-x-6 gap-y-1 text-[13px] md:grid-cols-2">
                    <div>
                      <span className="text-muted">Ask for: </span>
                      {brief.recommendedRoles.join(", ")}
                      <div className="text-[11.5px] text-faint">Roles only. Named contacts appear under Contacts when a source is on file.</div>
                    </div>
                    <div>
                      <span className="text-muted">Next action: </span>
                      {d.nextAction ?? brief.nextAction}
                    </div>
                  </div>
                  {brief.coldCallOpener || brief.discoveryQuestion ? (
                    <div className="grid gap-3 border-t border-line-soft pt-3 text-[13px] md:grid-cols-2">
                      {brief.coldCallOpener ? (
                        <div>
                          <div className="eyebrow mb-1">Cold-call opener</div>
                          <p className="leading-relaxed">&ldquo;{brief.coldCallOpener}&rdquo;</p>
                        </div>
                      ) : null}
                      {brief.discoveryQuestion ? (
                        <div>
                          <div className="eyebrow mb-1">Discovery question</div>
                          <p className="leading-relaxed">&ldquo;{brief.discoveryQuestion}&rdquo;</p>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  <div>
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Evidence</div>
                    <ul className="space-y-1">
                      {brief.claims.map((c, i) => (
                        <li key={i} className="grid grid-cols-[150px_1fr] items-baseline gap-2 text-[13px]">
                          <Provenance kind={c.kind} confidence={c.confidence} />
                          <span>
                            {c.text} <Refs refs={c.evidence} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : (
                <Empty>{obs ? "No product opportunity has been found in the evidence so far." : "No brief yet. Run a website scan to start collecting evidence."}</Empty>
              )}
            </div>
          </Panel>

          {/* ---- Scores ---- */}
          <Panel title="Opportunity scores" id="scores">
            <div className="grid gap-px bg-line-soft md:grid-cols-2">
              {PRODUCTS.map((p) => {
                const s = scoreRows.find((x) => x.product === p);
                return (
                  <div key={p} className="bg-surface p-3">
                    <div className="flex items-baseline justify-between">
                      <ProductTag product={p} />
                      <ScoreNumber score={s?.score ?? 0} />
                    </div>
                    <div className="mt-1.5">
                      <ReasonBar product={p} score={s?.score ?? 0} reasons={s?.reasons ?? []} />
                    </div>
                    {s && s.reasons.length ? (
                      <ul className="mt-2 space-y-1">
                        {s.reasons.map((r) => (
                          <li key={r.ruleId} className="grid grid-cols-[34px_1fr] gap-1 text-[12.5px]">
                            <span className="num text-muted">+{r.points}</span>
                            <span>
                              {r.label}
                              <span className="ml-2 inline-flex items-center gap-2">
                                <Provenance kind={r.kind} confidence={r.confidence} />
                                <Refs refs={r.evidence} />
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-[12.5px] text-faint">{s ? "No rule fired." : "Not scored yet."}</p>
                    )}
                  </div>
                );
              })}
            </div>
            {d.priorityBreakdown ? (
              <div className="border-t border-line p-3">
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">How the priority of {d.priorityScore} is built</div>
                <table className="w-full text-[12.5px]">
                  <tbody>
                    {d.priorityBreakdown.components.map((c) => (
                      <tr key={c.key}>
                        <td className="w-[190px] py-0.5">{c.label}</td>
                        <td className="num w-[70px] py-0.5">
                          {c.points} / {c.max}
                        </td>
                        <td className="py-0.5 text-muted">{c.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </Panel>

          {/* ---- Timeline ---- */}
          <Panel title="Evidence timeline">
            {timeline.length === 0 ? (
              <Empty>Nothing recorded yet.</Empty>
            ) : (
              <ol className="max-h-[360px] overflow-y-auto">
                {timeline.slice(0, 60).map((t, i) => (
                  <li key={i} className="grid grid-cols-[150px_1fr] gap-3 border-b border-line-soft px-3 py-1.5 text-[13px] last:border-b-0">
                    <span className="num text-[12px] text-muted">{fmtDate(t.at, true)}</span>
                    <a href={t.href} className={`hover:underline ${t.tone === "bad" ? "text-bad" : ""}`}>
                      {t.text}
                    </a>
                  </li>
                ))}
              </ol>
            )}
          </Panel>

          {/* ---- Website research ---- */}
          <Panel title="Website research" id="research" action={obs ? <span className="text-[12px] text-muted">{fmtDate(obs.timestamp, true)}</span> : null}>
            {!obs ? (
              <Empty>{d.website ? "Not scanned yet. The first scan is queued automatically; you can also run one now." : "Add a website to this dealership to enable research."}</Empty>
            ) : obs.websiteStatus !== "OK" ? (
              <div className="p-3 text-[13px]">
                <Badge tone="warn">{label(obs.websiteStatus)}</Badge>
                <p className="mt-2">{obs.statusDetail ?? "The homepage could not be read."}</p>
                <p className="mt-1 text-muted">Access controls are respected: the scan stopped here and recorded the block. Nothing was done to get around it.</p>
              </div>
            ) : (
              <div className="grid gap-px bg-line-soft md:grid-cols-2">
                <div className="space-y-1.5 bg-surface p-3 text-[13px]">
                  <Row k="Mobile friendly" v={obs.mobileFriendly === null ? "Not measured" : obs.mobileFriendly ? "Yes" : "No"} />
                  <Row k="Chat" v={obs.chatPresent ? `${obs.chatVendor ?? "Unrecognised vendor"}${obs.chatType && obs.chatType !== "UNKNOWN" ? ` (${label(obs.chatType)})` : ""}` : "None detected"} />
                  <Row k="Chat working" v={obs.chatWorking === null ? "Not tested" : obs.chatWorking ? "Yes" : "No"} />
                  <Row k="Lead forms" v={`${obs.leadFormCount}`} />
                  <Row k="Inventory page" v={obs.inventoryPagePresent ? `Yes${obs.inventoryCount !== null ? ` · ${obs.inventoryCount} vehicles` : ""}` : "Not found"} />
                  <Row k="Inventory alerts" v={obs.inventoryAlertsPresent === null ? "Not checked" : obs.inventoryAlertsPresent ? "Sign-up found" : "None found on scanned pages"} />
                  <Row k="Careers page" v={obs.careersUrl ? <ExternalLink href={obs.careersUrl} /> : "Not found"} />
                  {obs.notes ? <p className="pt-1 text-[12px] text-warn">{obs.notes}</p> : null}
                </div>
                <div className="space-y-1.5 bg-surface p-3 text-[13px]">
                  <Row k="Service page" v={obs.servicePagePresent ? "Yes" : "Not found"} />
                  <Row k="Scheduler" v={obs.service ? `${label(obs.service.schedulerMode)}${obs.serviceSchedulerVendor ? ` · ${obs.serviceSchedulerVendor}` : ""}` : "—"} />
                  <Row k="Service contact" v={obs.service?.contactOptions.join(", ") || "—"} />
                  <Row k="Service specials" v={obs.service ? (obs.service.specialsPresent ? "Yes" : "None seen") : "—"} />
                  {obs.service?.frictionNotes.length ? (
                    <ul className="list-disc pl-4 text-[12.5px] text-muted">
                      {obs.service.frictionNotes.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <div className="bg-surface p-3">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Forms found</div>
                  {obs.leadForms.length === 0 ? (
                    <p className="text-[12.5px] text-faint">None.</p>
                  ) : (
                    <ul className="space-y-1 text-[12.5px]">
                      {obs.leadForms.map((f, i) => (
                        <li key={i}>
                          <span className="font-medium">{label(f.type)}</span> <span className="text-muted">· {f.fields.length} fields · {new URL(f.pageUrl).pathname}</span>{" "}
                          {f.hasProhibitedFields || !SUBMITTABLE_FORM_TYPES.includes(f.type) ? <Badge>Never submitted</Badge> : null} {f.hasCaptcha ? <Badge tone="warn">CAPTCHA</Badge> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="bg-surface p-3" id="technology">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Technology detected</div>
                  {obs.detectedTechnology.length === 0 ? (
                    <p className="text-[12.5px] text-faint">Nothing recognised.</p>
                  ) : (
                    <ul className="space-y-0.5 text-[12.5px]">
                      {obs.detectedTechnology.map((t) => (
                        <li key={t.name} title={t.evidence}>
                          {t.name} <span className="text-muted">· {t.category}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="bg-surface p-3 md:col-span-2">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Pages visited</div>
                  <ul className="grid gap-x-6 text-[12.5px] md:grid-cols-2">
                    {obs.pages.map((pg, i) => (
                      <li key={i} className="truncate">
                        <span className={pg.outcome === "OK" ? "text-good" : "text-warn"}>{pg.outcome === "OK" ? "OK" : label(pg.outcome)}</span> <span className="text-muted">{label(pg.kind)}</span> {pg.url.replace(/^https?:\/\/[^/]+/, "") || "/"}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </Panel>

          {/* ---- Screenshots ---- */}
          <Panel title="Screenshots" id="screenshots" action={<A href={`/evidence?dealership=${id}`}>All evidence</A>}>
            {shots.length === 0 ? (
              <Empty>No screenshots yet.</Empty>
            ) : (
              <div className="grid grid-cols-2 gap-2 p-3 md:grid-cols-4">
                {shots.map((s) => (
                  <a key={s.id} href={`/api/evidence/${s.id}`} target="_blank" rel="noreferrer" className="block border border-line hover:border-text">
                    {/* eslint-disable-next-line @next/next/no-img-element -- authenticated evidence route, not an optimisable public asset */}
                    {s.contentType?.startsWith("audio/") ? <audio controls preload="none" src={`/api/evidence/${s.id}`} className="w-full" /> : <img src={`/api/evidence/${s.id}`} alt={`${label(s.type)} screenshot`} loading="lazy" className="aspect-[3/2] w-full object-cover object-top" />}
                    <div className="flex justify-between px-1.5 py-1 text-[11.5px] text-muted">
                      <span>{label(s.type)}</span>
                      <span className="num">{fmtDate(s.capturedAt, true)}</span>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </Panel>

          {/* ---- Signals ---- */}
          <Panel title="Hiring & business signals" id="signals">
            {signalRows.length === 0 ? (
              <Empty>No signals on file.</Empty>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Signal</th>
                    <th>Source</th>
                    <th>Evidence</th>
                    <th>Detected</th>
                  </tr>
                </thead>
                <tbody>
                  {signalRows.map((s) => (
                    <tr key={s.id}>
                      <td className="whitespace-nowrap">{label(s.type)}</td>
                      <td>
                        {s.title}
                        {s.description ? <div className="text-[12px] text-muted">{s.description}</div> : null}
                      </td>
                      <td>
                        <ExternalLink href={s.sourceUrl}>{label(s.source)}</ExternalLink>
                      </td>
                      <td>
                        <Provenance kind={s.kind} confidence={s.confidence} />
                      </td>
                      <td className="whitespace-nowrap text-[12px] text-muted">{fmtDate(s.detectedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {canOperate ? (
              <details className="border-t border-line px-3 py-2">
                <summary className="cursor-pointer text-[12.5px] text-blue-deep hover:text-blue">Add a signal with a source</summary>
                <form action={createSignal} className="mt-2 grid gap-2 md:grid-cols-4">
                  {hidden}
                  <input type="hidden" name="dealershipId" value={id} />
                  <Field label="Type">
                    <select className="input" name="type">
                      {SIGNAL_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {label(t)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Title" className="md:col-span-2">
                    <input className="input" name="title" required />
                  </Field>
                  <Field label="Confidence">
                    <select className="input" name="confidence" defaultValue="MEDIUM">
                      {CONFIDENCE.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Source URL (required)" className="md:col-span-2">
                    <input className="input" type="url" name="sourceUrl" required />
                  </Field>
                  <Field label="Description" className="md:col-span-2">
                    <input className="input" name="description" />
                  </Field>
                  <button className="btn w-fit" type="submit">
                    Add signal
                  </button>
                </form>
              </details>
            ) : null}
          </Panel>

          {/* ---- Social ---- */}
          <Panel title="Social" id="social">
            <div className="p-3 text-[13px]">
              <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1">
                {profiles.length === 0 ? <span className="text-muted">No social profiles found on the website yet.</span> : profiles.map((p) => <ExternalLink key={p.id} href={p.url}>{label(p.platform)}</ExternalLink>)}
              </div>
              <p className="text-[12px] text-faint">Activity figures are operator-entered in this version (no platform API connector is configured). Each one keeps its source link.</p>
            </div>
            {social.length ? (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Platform</th>
                    <th className="text-right">Posts / 30d</th>
                    <th className="text-right">Inventory posts</th>
                    <th className="text-right">Questions</th>
                    <th className="text-right">Unanswered</th>
                    <th>Ads</th>
                    <th>Source</th>
                    <th>Observed</th>
                  </tr>
                </thead>
                <tbody>
                  {social.map((s) => (
                    <tr key={s.id}>
                      <td>{label(s.platform)}</td>
                      <td className="num text-right">{s.postsLast30Days ?? "—"}</td>
                      <td className="num text-right">{s.inventoryPostsLast30Days ?? "—"}</td>
                      <td className="num text-right">{s.customerQuestions ?? "—"}</td>
                      <td className="num text-right">{s.unansweredQuestions ?? "—"}</td>
                      <td>{s.adActivity === null ? "—" : s.adActivity ? "Yes" : "No"}</td>
                      <td>{s.sourceUrl ? <ExternalLink href={s.sourceUrl}>{s.recordedBy ?? s.source}</ExternalLink> : s.source}</td>
                      <td className="whitespace-nowrap text-[12px] text-muted">{fmtDate(s.observedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            {canOperate ? (
              <details className="border-t border-line px-3 py-2">
                <summary className="cursor-pointer text-[12.5px] text-blue-deep hover:text-blue">Record a social observation</summary>
                <form action={recordSocial} className="mt-2 grid gap-2 md:grid-cols-4">
                  {hidden}
                  <input type="hidden" name="dealershipId" value={id} />
                  <Field label="Platform">
                    <select className="input" name="platform">
                      {["facebook", "instagram", "tiktok", "youtube", "x"].map((p) => (
                        <option key={p} value={p}>
                          {label(p)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Posts, last 30 days">
                    <input className="input" type="number" min={0} name="postsLast30Days" />
                  </Field>
                  <Field label="Inventory posts">
                    <input className="input" type="number" min={0} name="inventoryPostsLast30Days" />
                  </Field>
                  <Field label="Customer questions">
                    <input className="input" type="number" min={0} name="customerQuestions" />
                  </Field>
                  <Field label="Unanswered questions">
                    <input className="input" type="number" min={0} name="unansweredQuestions" />
                  </Field>
                  <Field label="Running ads?">
                    <select className="input" name="adActivity" defaultValue="">
                      <option value="">Unknown</option>
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </select>
                  </Field>
                  <Field label="Confidence">
                    <select className="input" name="confidence" defaultValue="MEDIUM">
                      {CONFIDENCE.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Source URL (required)">
                    <input className="input" type="url" name="sourceUrl" required />
                  </Field>
                  <Field label="Notes" className="md:col-span-3">
                    <input className="input" name="notes" />
                  </Field>
                  <div className="flex items-end">
                    <button className="btn" type="submit">
                      Record observation
                    </button>
                  </div>
                </form>
              </details>
            ) : null}
          </Panel>

          {/* ---- Size of operation (estimated) ---- */}
          <Panel title="Size of operation · estimate" id="volume">
            {(() => {
              const v = estimateVolume(inventory);
              if (!v) return <Empty>No inventory read yet, so nothing to estimate from.</Empty>;
              const range = (lo: number, hi: number) => (lo === hi ? String(lo) : `${lo}–${hi}`);
              return (
                <div className="grid gap-4 p-4 md:grid-cols-[1fr_1fr]">
                  <div>
                    <Row k="On the lot now" v={v.onHand !== null ? `${v.onHand} vehicles${v.lotUsed !== v.onHand ? ` (estimated as ${v.lotUsed})` : ""}` : "Not countable"} />
                    <Row k="Stock" v={`${SEGMENT_LABEL[v.segment]} · turns every ${v.turnDaysLow}–${v.turnDaysHigh} days`} />
                    <Row k="Vehicles sold a month" v={<span className="num font-medium">about {range(v.unitsLow, v.unitsHigh)}</span>} />
                    <Row k="Gross profit a month" v={v.profitLow !== null && v.profitHigh !== null ? <span className="num font-medium">{fmtUsd(v.profitLow)} – {fmtUsd(v.profitHigh)}</span> : "No asking prices read yet"} />
                    <Row k="Made per vehicle" v={v.profitPerUnit !== null ? `about ${fmtUsd(v.profitPerUnit)} front-end gross · salesperson about ${fmtUsd(v.commissionPerUnit ?? 0)}` : "—"} />
                    <Row k="Sales volume a month" v={v.grossLow !== null && v.grossHigh !== null ? `${fmtUsd(v.grossLow)} – ${fmtUsd(v.grossHigh)} (units × median asking price)` : "—"} />
                    <Row k="Typical asking price" v={v.medianPrice !== null ? fmtUsd(v.medianPrice) : "—"} />
                  </div>
                  <div className="text-[13px] leading-relaxed text-muted">
                    <div className="mb-1.5 flex items-center gap-2">
                      <Badge tone={v.confidence === "HIGH" ? "good" : v.confidence === "MEDIUM" ? "warn" : "neutral"}>{v.confidence === "HIGH" ? "High confidence" : v.confidence === "MEDIUM" ? "Medium confidence" : "Low confidence"}</Badge>
                      <span>{v.method === "TURNOVER" ? `Measured from inventory turnover over ${v.daysObserved} days` : "First guess from lot size and segment norms"}</span>
                    </div>
                    <p>{v.basis}.</p>
                    <div className="eyebrow mt-2">What Sentinel assumed</div>
                    <ul className="list-disc space-y-0.5 pl-4">
                      {v.assumptions.map((a) => (
                        <li key={a}>{a}</li>
                      ))}
                    </ul>
                    <p className="mt-1.5 text-faint">Estimates from what the website shows and industry norms for independent dealers, never reported figures. Gross profit is the front-end spread before expenses; it firms up as weekly inventory reads accumulate.</p>
                  </div>
                </div>
              );
            })()}
          </Panel>

          {/* ---- Inventory ---- */}
          <Panel title="Inventory history" id="inventory">
            {inventory.length === 0 ? (
              <Empty>No inventory snapshots yet.</Empty>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Captured</th>
                    <th className="text-right">Total</th>
                    <th className="text-right">New</th>
                    <th className="text-right">Used</th>
                    <th className="text-right">Listings seen</th>
                    <th>How it was counted</th>
                    <th>Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {inventory.map((s) => (
                    <tr key={s.id}>
                      <td className="whitespace-nowrap">{fmtDate(s.capturedAt, true)}</td>
                      <td className="num text-right">{s.total ?? "—"}</td>
                      <td className="num text-right">{s.newCount ?? "—"}</td>
                      <td className="num text-right">{s.usedCount ?? "—"}</td>
                      <td className="num text-right">{s.vdpUrls.length}</td>
                      <td>{s.method === "PAGE_COUNT_TEXT" ? "Total stated on the page" : s.method === "VDP_LINK_COUNT" ? "Listing links on first page (a minimum)" : "Could not be counted"}</td>
                      <td>{label(s.confidence)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>

        {/* ================= Right column ================= */}
        <div className="space-y-4">
          <Panel title="Pipeline & next action">
            <form action={setPipeline} className="space-y-2 p-3">
              {hidden}
              <input type="hidden" name="id" value={id} />
              <Field label="Stage">
                <select className="input" name="stage" defaultValue={d.pipelineStage} disabled={!canOperate}>
                  {PIPELINE_STAGES.map((s) => (
                    <option key={s} value={s}>
                      {label(s)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Next action">
                <input className="input" name="nextAction" defaultValue={d.nextAction ?? ""} list="next-actions" disabled={!canOperate} />
                <datalist id="next-actions">
                  {["Call GM", "Contact BDC Director", "Contact Marketing Director", "Research group ownership", "Review interaction response", "Wait for response timer"].map((a) => (
                    <option key={a} value={a} />
                  ))}
                </datalist>
              </Field>
              <Field label="Due">
                <input className="input" type="date" name="nextActionDue" defaultValue={d.nextActionDue?.toISOString().slice(0, 10) ?? ""} disabled={!canOperate} />
              </Field>
              {canOperate ? (
                <button className="btn btn-primary" type="submit">
                  Save pipeline
                </button>
              ) : null}
            </form>
            {canOperate ? (
              <form action={setPriority} className="flex items-end gap-2 border-t border-line p-3">
                {hidden}
                <input type="hidden" name="id" value={id} />
                <Field label="Manual priority" hint="Leave empty to use the computed score" className="flex-1">
                  <input className="input" type="number" min={0} max={100} name="priorityOverride" defaultValue={d.priorityOverride ?? ""} />
                </Field>
                <button className="btn" type="submit">
                  Set
                </button>
              </form>
            ) : null}
          </Panel>

          <Panel title="Contacts">
            {contactRows.length === 0 ? (
              <Empty>No named contacts. Only people backed by a source are listed here.</Empty>
            ) : (
              <ul>
                {contactRows.map((c) => (
                  <li key={c.id} className="border-b border-line-soft px-3 py-2 text-[13px] last:border-b-0">
                    <div className="font-medium">{c.name}</div>
                    <div className="text-[12px] text-muted">{[c.title, c.email, c.phone].filter(Boolean).join(" · ")}</div>
                    <div className="text-[11.5px]">
                      <ExternalLink href={c.sourceUrl}>Source</ExternalLink>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {canOperate ? (
              <details className="border-t border-line px-3 py-2">
                <summary className="cursor-pointer text-[12.5px] text-blue-deep hover:text-blue">Add a contact</summary>
                <form action={addContact} className="mt-2 space-y-2">
                  {hidden}
                  <input type="hidden" name="dealershipId" value={id} />
                  <input className="input" name="name" placeholder="Name" required />
                  <input className="input" name="title" placeholder="Title" />
                  <input className="input" type="email" name="email" placeholder="Email" />
                  <input className="input" name="phone" placeholder="Phone" />
                  <input className="input" type="url" name="sourceUrl" placeholder="Source URL (required)" required />
                  <button className="btn" type="submit">
                    Add contact
                  </button>
                </form>
              </details>
            ) : null}
          </Panel>

          <Panel title="Notes">
            {canOperate ? (
              <form action={addNote} className="space-y-2 border-b border-line p-3">
                {hidden}
                <input type="hidden" name="dealershipId" value={id} />
                <textarea className="input" name="body" rows={2} placeholder="Add a note" required />
                <button className="btn" type="submit">
                  Add note
                </button>
              </form>
            ) : null}
            {noteRows.length === 0 ? (
              <Empty>No notes.</Empty>
            ) : (
              <ul>
                {noteRows.map((n) => (
                  <li key={n.id} className="border-b border-line-soft px-3 py-2 text-[13px] last:border-b-0">
                    <div className="whitespace-pre-wrap">{n.body}</div>
                    <div className="mt-0.5 text-[11.5px] text-faint">
                      {n.author} · {fmtDate(n.createdAt, true)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {canOperate ? (
            <>
              <Panel title="Suppress from testing">
                <form action={suppress} className="space-y-2 p-3">
                  {hidden}
                  <input type="hidden" name="scope" value="DEALERSHIP" />
                  <input type="hidden" name="dealershipId" value={id} />
                  <Field label="Reason">
                    <select className="input" name="reason" defaultValue="MANUAL">
                      {SUPPRESSION_REASONS.map((r) => (
                        <option key={r} value={r}>
                          {label(r)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <input className="input" name="note" placeholder="Note (optional)" />
                  <button className="btn btn-danger" type="submit">
                    Suppress dealership
                  </button>
                  <p className="text-[11.5px] text-faint">
                    Lift it on the <A href="/suppression">Suppression</A> page.
                  </p>
                </form>
              </Panel>

              <Panel title="Edit details">
                <details className="p-3">
                  <summary className="cursor-pointer text-[12.5px] text-blue-deep hover:text-blue">Edit dealership details</summary>
                  <form action={updateDealership} className="mt-2 space-y-2">
                    {hidden}
                    <input type="hidden" name="id" value={id} />
                    <Field label="Name">
                      <input className="input" name="name" defaultValue={d.name} required />
                    </Field>
                    <Field label="Website">
                      <input className="input" name="website" defaultValue={d.website ?? ""} />
                    </Field>
                    <Field label="Phone">
                      <input className="input" name="phone" defaultValue={d.phone ?? ""} />
                    </Field>
                    <Field label="Address">
                      <input className="input" name="address" defaultValue={d.address ?? ""} />
                    </Field>
                    <div className="grid grid-cols-[1fr_52px_76px] gap-2">
                      <input className="input" name="city" defaultValue={d.city ?? ""} placeholder="City" />
                      <input className="input" name="state" defaultValue={d.state ?? ""} placeholder="ST" maxLength={2} />
                      <input className="input" name="zip" defaultValue={d.zip ?? ""} placeholder="ZIP" />
                    </div>
                    <Field label="Brands">
                      <input className="input" name="brands" defaultValue={d.brands.join(", ")} />
                    </Field>
                    <Field label="Dealer group">
                      <select className="input" name="groupId" defaultValue={d.groupId ?? ""}>
                        <option value="">None</option>
                        {allGroups.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <button className="btn" type="submit">
                      Save details
                    </button>
                  </form>
                </details>
                {hasRole(user, "ADMIN") ? (
                  <details className="border-t border-line p-3">
                    <summary className="cursor-pointer text-[12.5px] text-bad">Delete this dealership…</summary>
                    <form action={deleteDealership} className="mt-2">
                      <input type="hidden" name="back" value={back} />
                      <input type="hidden" name="id" value={id} />
                      <p className="mb-2 text-[12px] text-muted">Removes the rooftop with its scans, tests, responses and scores. This cannot be undone.</p>
                      <button className="btn btn-danger" type="submit">
                        Delete dealership and its evidence
                      </button>
                    </form>
                  </details>
                ) : null}
              </Panel>
            </>
          ) : null}
        </div>
      </div>
        </div>
      </details>
    </>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[130px_1fr] gap-2">
      <span className="text-muted">{k}</span>
      <span>{v}</span>
    </div>
  );
}

/** "Call" — Charlie phones the number and records what answers. Explains itself when it cannot run. */
function PhoneCheckButton({ dealershipId, approved }: { dealershipId: string; approved: boolean }) {
  const ready = twilioConfigured();
  const why = !ready ? "Twilio is not configured on the server" : !approved ? "Approve this dealership for testing first" : null;
  return (
    <form action={queuePhoneCheck} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="dealershipId" value={dealershipId} />
      <button className="btn btn-sm" type="submit" disabled={!!why} title={why ?? "Charlie calls the number, speaks the script from Settings, records what answers and hangs up"}>
        Call with Charlie
      </button>
      {why ? <span className="text-[11.5px] text-faint">{why}</span> : null}
    </form>
  );
}
