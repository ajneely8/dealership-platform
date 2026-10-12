import { desc, eq, isNull } from "drizzle-orm";
import { approveInteraction, cancelInteraction, approveAllPending } from "@/app/actions";
import { A, Badge, Empty, Flash, PageHeader, Panel, fmtDate, label } from "@/components/ui";
import { db } from "@/db";
import { dealerships, testIdentities, testInteractions, unmatchedInbound } from "@/db/schema";
import { formatDuration } from "@/domain/response-timing";
import { hasRole, requireUser } from "@/lib/auth/session";
import { getSettings } from "@/lib/settings";

const TONE: Record<string, "neutral" | "good" | "warn" | "bad"> = { MONITORING: "warn", COMPLETED: "good", FAILED: "bad", BLOCKED: "bad", PENDING_APPROVAL: "warn" };

export default async function InteractionsPage({ searchParams }: { searchParams: Promise<{ notice?: string; error?: string }> }) {
  const { notice, error } = await searchParams;
  const user = await requireUser();
  const canOperate = hasRole(user, "OPERATOR");
  const [rows, unmatched, settings] = await Promise.all([
    db()
      .select({ i: testInteractions, dealer: dealerships.name, identity: testIdentities.name })
      .from(testInteractions)
      .innerJoin(dealerships, eq(dealerships.id, testInteractions.dealershipId))
      .leftJoin(testIdentities, eq(testIdentities.id, testInteractions.identityId))
      .orderBy(desc(testInteractions.createdAt))
      .limit(200),
    db().select().from(unmatchedInbound).where(isNull(unmatchedInbound.resolvedInteractionId)).orderBy(desc(unmatchedInbound.receivedAt)).limit(30),
    getSettings(),
  ]);
  const pending = rows.filter((r) => r.i.status === "PENDING_APPROVAL");

  return (
    <>
      <PageHeader title="Interactions" sub="Controlled tests of dealership lead forms, and the responses that came back." />
      <Flash notice={notice} error={error} />
      {!settings.testingEnabled ? (
        <div className="mb-3 rounded-md border border-line bg-surface px-3 py-2 text-[13px]">
          Controlled testing is <span className="font-medium">off</span>. Research is passive only. An admin can turn testing on in <A href="/settings">Settings</A> once a test identity is configured.
        </div>
      ) : null}

      {pending.length ? (
        <Panel title={`Waiting for approval (${pending.length})`} className="mb-4" action={pending.length > 1 ? (<form action={approveAllPending}><button className="btn btn-primary btn-sm" type="submit">Approve all {pending.length}</button></form>) : null}>
          <ul>
            {pending.map(({ i, dealer, identity }) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 border-b border-line-soft px-3 py-2 text-[13px] last:border-b-0">
                <A href={`/dealerships/${i.dealershipId}#interactions`}>{dealer}</A>
                <span>{i.testType === "CHAT" ? "Chat test" : `${label(i.formType ?? "form")} form`}</span>
                <span className="text-muted">&ldquo;{i.message}&rdquo;</span>
                <span className="text-[12px] text-muted">
                  as {identity ?? "—"} · requested by {i.requestedBy}
                </span>
                {canOperate ? (
                  <span className="ml-auto flex gap-2">
                    <form action={approveInteraction}>
                      <input type="hidden" name="back" value="/interactions" />
                      <input type="hidden" name="id" value={i.id} />
                      <button className="btn btn-sm btn-primary" type="submit">
                        Approve and submit
                      </button>
                    </form>
                    <form action={cancelInteraction}>
                      <input type="hidden" name="back" value="/interactions" />
                      <input type="hidden" name="id" value={i.id} />
                      <button className="btn btn-sm" type="submit">
                        Cancel
                      </button>
                    </form>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel title="All tests">
        {rows.length === 0 ? (
          <Empty>No tests yet. Request one from a dealership page after its website has been scanned.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Dealership</th>
                  <th>Type</th>
                  <th>Submitted</th>
                  <th>First response</th>
                  <th>Identity</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ i, dealer, identity }) => (
                  <tr key={i.id}>
                    <td>
                      <Badge tone={TONE[i.status] ?? "neutral"}>{label(i.status)}</Badge>
                    </td>
                    <td>
                      <A href={`/dealerships/${i.dealershipId}#interactions`}>{dealer}</A>
                    </td>
                    <td className="whitespace-nowrap">{i.testType === "FORM" ? `${label(i.formType ?? "form")} form` : "Chat"}</td>
                    <td className="num whitespace-nowrap text-[12.5px]">{fmtDate(i.submittedAt, true)}</td>
                    <td className="whitespace-nowrap">{i.firstResponseSeconds !== null ? formatDuration(i.firstResponseSeconds) : i.submittedAt && i.testType === "FORM" ? <span className="text-bad">None yet</span> : "—"}</td>
                    <td>{identity ?? "—"}</td>
                    <td className="max-w-[360px] text-[12.5px] text-muted">{i.statusDetail ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Inbound messages not matched to a test" className="mt-4">
        {unmatched.length === 0 ? (
          <Empty>None. Messages land here when they reach a test identity but can&apos;t be tied to exactly one open test.</Empty>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Received</th>
                <th>Channel</th>
                <th>From</th>
                <th>To</th>
                <th>Message</th>
                <th>Why unmatched</th>
              </tr>
            </thead>
            <tbody>
              {unmatched.map((u) => (
                <tr key={u.id}>
                  <td className="num whitespace-nowrap text-[12.5px]">{fmtDate(u.receivedAt, true)}</td>
                  <td>{u.channel}</td>
                  <td>{u.sender ?? "—"}</td>
                  <td>{u.recipient ?? "—"}</td>
                  <td className="max-w-[360px] text-[12.5px]">{u.message ?? "—"}</td>
                  <td className="text-[12.5px] text-muted">{u.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {unmatched.length ? <p className="border-t border-line px-3 py-2 text-[12px] text-muted">To attach one, open the dealership&apos;s test and use &ldquo;Record a response by hand&rdquo; with the time shown here.</p> : null}
      </Panel>
    </>
  );
}
