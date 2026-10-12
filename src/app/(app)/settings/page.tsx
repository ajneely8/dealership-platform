import { createIdentity, createUser, saveScoring, saveSettings, toggleIdentity } from "@/app/actions";
import { twilioConfigured } from "@/lib/telephony";
import { Badge, Empty, Field, Flash, PageHeader, Panel, ProductTag, fmtDate, label } from "@/components/ui";
import { db } from "@/db";
import { testIdentities, users } from "@/db/schema";
import { PRODUCTS, ROLES } from "@/domain/constants";
import { RULES } from "@/domain/scoring/config";
import { env } from "@/env";
import { hasRole, requireUser } from "@/lib/auth/session";
import { getSettings } from "@/lib/settings";

const THRESHOLD_LABEL: Record<string, string> = {
  largeInventory: "Large inventory (vehicles)",
  inventoryMovementPct: "High movement (% of listings changed)",
  schedulerFieldCount: "High-friction scheduler (fields)",
  socialPostsPerMonth: "High social activity (posts / 30 days)",
  socialInventoryPostsPerMonth: "Inventory heavily promoted (posts / 30 days)",
  socialCustomerQuestions: "Customer questions (count)",
  socialUnansweredQuestions: "Unanswered questions (count)",
  signalRecencyDays: "Signals count for (days)",
};

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ notice?: string; error?: string }> }) {
  const { notice, error } = await searchParams;
  const user = await requireUser();
  const admin = hasRole(user, "ADMIN");
  const [s, identities, userRows] = await Promise.all([getSettings(), db().select().from(testIdentities).orderBy(testIdentities.name), db().select().from(users).orderBy(users.name)]);
  const e = env();
  const provider = s.aiProvider === "env" ? e.AI_PROVIDER : s.aiProvider;
  // Only whether a key exists is ever sent to the browser, never the key.
  const aiReady = provider === "anthropic" && Boolean(e.ANTHROPIC_API_KEY);
  const phoneReady = twilioConfigured();
  const num = (name: string, value: number, min: number, max: number) => <input className="input num" type="number" name={name} defaultValue={value} min={min} max={max} disabled={!admin} required />;

  return (
    <>
      <PageHeader title="Settings" sub={admin ? "Changes are recorded in the audit log." : "View only. Ask an admin to change settings."} />
      <Flash notice={notice} error={error} />

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Research & testing">
          <form action={saveSettings} className="space-y-3 p-3">
            <input type="hidden" name="back" value="/settings" />
            <label className="flex items-start gap-2 rounded-md border border-line p-2.5 text-[13px]">
              <input type="checkbox" name="testingEnabled" defaultChecked={s.testingEnabled} disabled={!admin} className="mt-0.5" />
              <span>
                <span className="font-medium">Allow controlled tests</span>
                <span className="block text-[12px] text-muted">Off = passive research only. Even when on, each test needs an approved dealership, an approved identity, and a person to approve it.</span>
              </span>
            </label>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
              <Field label="Cooldown (days)" hint="Minimum 30">
                {num("interactionCooldownDays", s.interactionCooldownDays, 30, 365)}
              </Field>
              <Field label="Response window (hours)">{num("responseMonitorHours", s.responseMonitorHours, 1, 168)}</Field>
              <Field label="Max chat messages" hint={`Ceiling ${e.MAX_CHAT_MESSAGES}`}>
                {num("maxChatMessages", Math.min(s.maxChatMessages, e.MAX_CHAT_MESSAGES), 0, e.MAX_CHAT_MESSAGES)}
              </Field>
              <Field label="Max human replies" hint="The system never replies in this version">
                {num("maxHumanReplies", Math.min(s.maxHumanReplies, e.MAX_HUMAN_REPLIES), 0, e.MAX_HUMAN_REPLIES)}
              </Field>
              <Field label="Website scan every (days)">{num("websiteScanIntervalDays", s.websiteScanIntervalDays, 1, 90)}</Field>
              <Field label="Inventory every (days)">{num("inventoryScanIntervalDays", s.inventoryScanIntervalDays, 1, 30)}</Field>
              <Field label="Social every (days)">{num("socialScanIntervalDays", s.socialScanIntervalDays, 1, 30)}</Field>
              <Field label="Signals every (days)">{num("signalScanIntervalDays", s.signalScanIntervalDays, 1, 30)}</Field>
              <Field label="Keep screenshots (days)">{num("screenshotRetentionDays", s.screenshotRetentionDays, 7, 3650)}</Field>
              <Field label="Keep research data (days)">{num("evidenceRetentionDays", s.evidenceRetentionDays, 30, 3650)}</Field>
            </div>

            <div className="border-t border-line pt-3">
              <div className="mb-2 text-[13px] font-medium">Prospecting</div>
              <p className="mb-2 text-[12px] text-muted">Nova finds car dealers from OpenStreetMap around the centre point, nearest first, screens one every interval, and admits only sites that can be researched: readable, with inventory and a way to make contact, and a chat widget that actually appears if one is installed. Rejections are listed under Prospecting and never become dealerships.</p>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
                <label className="flex items-center gap-2 pt-5 text-[13px]">
                  <input type="checkbox" name="prospectingEnabled" defaultChecked={s.prospectingEnabled} disabled={!admin} /> Find new dealerships
                </label>
                <Field label="Every (seconds)">{num("prospectIntervalSeconds", s.prospectIntervalSeconds, 15, 3600)}</Field>
                <label className="flex items-center gap-2 pt-5 text-[13px]">
                  <input type="checkbox" name="prospectingAroundTheClock" defaultChecked={s.prospectingAroundTheClock} disabled={!admin} /> Around the clock
                </label>
                <Field label="Centre latitude">
                  <input className="input num" name="prospectCenterLat" type="number" step="0.0001" defaultValue={s.prospectCenterLat} disabled={!admin} required />
                </Field>
                <Field label="Centre longitude">
                  <input className="input num" name="prospectCenterLng" type="number" step="0.0001" defaultValue={s.prospectCenterLng} disabled={!admin} required />
                </Field>
                <Field label="Start radius (km)">{num("prospectRadiusKm", s.prospectRadiusKm, 10, 400)}</Field>
                <Field label="Research browser presents as" className="md:col-span-2" hint="Visitor reads far more sites; CAPTCHAs and bot challenges are never bypassed either way">
                  <select className="input" name="researchPresentation" defaultValue={s.researchPresentation} disabled={!admin}>
                    <option value="visitor">A normal Chrome (research tag kept in the user agent)</option>
                    <option value="research">Headless research browser</option>
                  </select>
                </Field>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-6">
                <label className="flex items-center gap-2 pt-5 text-[13px]">
                  <input type="checkbox" name="prospectNationwide" defaultChecked={s.prospectNationwide} disabled={!admin} /> Nationwide (rotate US metros)
                </label>
                <Field label="Chat tests for admitted dealerships" className="md:col-span-2" hint="request = Charlie's test waits for your approval; auto = it runs on its own">
                  <select className="input" name="chatTestMode" defaultValue={s.chatTestMode} disabled={!admin}>
                    <option value="manual">Manual only</option>
                    <option value="request">Request automatically, I approve</option>
                    <option value="auto">Run automatically</option>
                  </select>
                </Field>
              </div>
            </div>

            <div className="border-t border-line pt-3">
              <div className="mb-2 flex items-center gap-2 text-[13px]">
                <span className="font-medium">Phone checks (AI receptionist)</span>
                {phoneReady ? <Badge tone="good">Twilio ready</Badge> : <Badge tone="warn">Twilio not configured</Badge>}
              </div>
              <p className="mb-2 text-[12px] text-muted">Charlie calls the dealership&apos;s number once and listens: the ring count is measured, a person who answers is hung up on at once (nothing is said), and a recording, menu or AI receptionist is recorded for under a minute and classified from what it says. Charlie never speaks, so no message is left anywhere. Needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER on the server. Calls are recorded: you are responsible for call-recording consent rules in the state you call.</p>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                <input type="hidden" name="phoneCheckScript" value={s.phoneCheckScript} />
                <Field label="When to call">
                  <select className="input" name="phoneCheckMode" defaultValue={s.phoneCheckMode} disabled={!admin}>
                    <option value="manual">Only when I click &ldquo;Call with Charlie&rdquo;</option>
                    <option value="auto">Each newly admitted dealership, once</option>
                  </select>
                </Field>
                <label className="flex items-center gap-2 pt-1 text-[13px] md:col-span-3">
                  <input type="checkbox" name="phoneHangUpOnHuman" defaultChecked={s.phoneHangUpOnHuman} disabled={!admin} /> Hang up as soon as a person answers (they hear nothing; the ring count and &ldquo;a person answered&rdquo; are still recorded)
                </label>
              </div>
            </div>

            <div className="border-t border-line pt-3">
              <div className="mb-2 text-[13px] font-medium">Research hours</div>
              <p className="mb-2 text-[12px] text-muted">Website research and browser tests run only inside this window. Replies from dealerships are recorded at any hour. Work you start by hand runs right away.</p>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <label className="flex items-center gap-2 pt-5 text-[13px]">
                  <input type="checkbox" name="researchWindowEnabled" defaultChecked={s.researchWindowEnabled} disabled={!admin} /> Limit to a window
                </label>
                <Field label="Start">
                  <input className="input num" type="time" name="researchWindowStart" defaultValue={s.researchWindowStart} disabled={!admin} required />
                </Field>
                <Field label="End">
                  <input className="input num" type="time" name="researchWindowEnd" defaultValue={s.researchWindowEnd} disabled={!admin} required />
                </Field>
                <Field label="Time zone" hint="IANA name">
                  <input className="input num" name="timezone" defaultValue={s.timezone} disabled={!admin} required />
                </Field>
              </div>
            </div>

            <div className="border-t border-line pt-3">
              <div className="mb-2 flex items-center gap-2 text-[13px]">
                <span className="font-medium">AI</span>
                {aiReady ? <Badge tone="good">Ready · {provider}</Badge> : <Badge tone="warn">{provider === "none" ? "Not configured" : "API key missing on the server"}</Badge>}
              </div>
              <p className="mb-2 text-[12px] text-muted">Without AI, responses are classified by text rules and sales angles use the standard template. Scores never depend on AI.</p>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <Field label="Provider">
                  <select className="input" name="aiProvider" defaultValue={s.aiProvider} disabled={!admin}>
                    <option value="env">From server env ({e.AI_PROVIDER})</option>
                    <option value="anthropic">Anthropic (Claude)</option>
                    <option value="none">None</option>
                  </select>
                </Field>
                <Field label="Model" hint={`Blank = ${e.AI_MODEL}`}>
                  <input className="input num" name="aiModel" defaultValue={s.aiModel} disabled={!admin} />
                </Field>
                <Field label="Max requests / job">{num("maxAIRequestsPerJob", s.maxAIRequestsPerJob, 0, 20)}</Field>
                <Field label="Max tokens / job">{num("maxAITokensPerJob", s.maxAITokensPerJob, 0, 200000)}</Field>
              </div>
            </div>
            {admin ? (
              <button className="btn btn-primary" type="submit">
                Save settings
              </button>
            ) : null}
          </form>
          <div className="border-t border-line px-3 py-2 text-[12px] text-muted">
            Fixed by server configuration: appointment booking, finance applications, trade-in forms and test-drive requests are <span className="font-medium text-text">never</span> submitted. Evidence storage: <span className="num">{e.STORAGE_DRIVER}</span>.
          </div>
        </Panel>

        <div className="space-y-4">
          <Panel title="Test identities">
            {identities.length === 0 ? (
              <Empty>No identities. Tests cannot run until a company-owned identity is added.</Empty>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Phone</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {identities.map((t) => (
                    <tr key={t.id}>
                      <td>{t.name}</td>
                      <td>{t.email}</td>
                      <td className="num">{t.phone}</td>
                      <td>{t.active ? <Badge tone="good">Active</Badge> : <Badge>Inactive</Badge>}</td>
                      <td>
                        {admin ? (
                          <form action={toggleIdentity}>
                            <input type="hidden" name="back" value="/settings" />
                            <input type="hidden" name="id" value={t.id} />
                            <input type="hidden" name="active" value={String(!t.active)} />
                            <button className="btn btn-sm" type="submit">
                              {t.active ? "Deactivate" : "Activate"}
                            </button>
                          </form>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {admin ? (
              <form action={createIdentity} className="grid gap-2 border-t border-line p-3 md:grid-cols-2">
                <input type="hidden" name="back" value="/settings" />
                <Field label="Name">
                  <input className="input" name="name" required />
                </Field>
                <Field label="Email (an inbox you control)">
                  <input className="input" type="email" name="email" required />
                </Field>
                <Field label="Phone (a number you control)">
                  <input className="input" name="phone" required />
                </Field>
                <Field label="Address (optional)">
                  <input className="input" name="address" />
                </Field>
                <label className="flex items-start gap-2 text-[12.5px] md:col-span-2">
                  <input type="checkbox" name="authorized" className="mt-0.5" required />
                  <span>This name, inbox and phone number belong to our company and I am authorised to use them for research. It is not a real customer or another person.</span>
                </label>
                <button className="btn w-fit" type="submit">
                  Add identity
                </button>
              </form>
            ) : null}
          </Panel>

          <Panel title="Users">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {userRows.map((u) => (
                  <tr key={u.id}>
                    <td>{u.name}</td>
                    <td>{u.email}</td>
                    <td>{label(u.role)}</td>
                    <td className="text-[12px] text-muted">{fmtDate(u.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {admin ? (
              <form action={createUser} className="grid gap-2 border-t border-line p-3 md:grid-cols-4">
                <input type="hidden" name="back" value="/settings" />
                <input className="input" name="name" placeholder="Name" required />
                <input className="input" type="email" name="email" placeholder="Email" required />
                <select className="input" name="role" defaultValue="OPERATOR">
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {label(r)}
                    </option>
                  ))}
                </select>
                <input className="input" type="password" name="password" placeholder="Password (12+ characters)" minLength={12} autoComplete="new-password" required />
                <button className="btn w-fit" type="submit">
                  Add user
                </button>
              </form>
            ) : null}
          </Panel>
        </div>
      </div>

      <Panel title="Scoring rules" className="mt-4">
        <form action={saveScoring}>
          <input type="hidden" name="back" value="/settings" />
          <p className="border-b border-line px-3 py-2 text-[12.5px] text-muted">A product&apos;s score is the sum of the points for every rule that fires, capped at 100. Set a rule to 0 to switch it off. Saving re-scores every dealership.</p>
          <div className="grid gap-px bg-line-soft md:grid-cols-2 xl:grid-cols-4">
            {PRODUCTS.map((p) => (
              <div key={p} className="bg-surface p-3">
                <div className="mb-2">
                  <ProductTag product={p} />
                </div>
                <div className="space-y-1.5">
                  {RULES.filter((r) => r.product === p).map((r) => (
                    <label key={r.id} className="grid grid-cols-[1fr_62px] items-center gap-2 text-[12.5px]">
                      <span>
                        {r.label}
                        <span className="block text-[11px] text-faint">{r.needs === "INTERACTION" ? "needs a controlled test" : r.needs === "SIGNAL" ? "needs a signal" : r.needs === "SOCIAL" ? "needs a social observation" : "from website scan"}</span>
                      </span>
                      <input className="input num" type="number" min={0} max={100} name={`w:${r.id}`} defaultValue={s.scoringWeights[r.id] ?? r.defaultPoints} disabled={!admin} />
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="grid gap-2 border-t border-line p-3 md:grid-cols-4">
            {Object.entries(s.scoringThresholds).map(([k, v]) => (
              <Field key={k} label={THRESHOLD_LABEL[k] ?? k}>
                <input className="input num" type="number" min={1} name={`t:${k}`} defaultValue={v} disabled={!admin} />
              </Field>
            ))}
          </div>
          {admin ? (
            <div className="border-t border-line p-3">
              <button className="btn btn-primary" type="submit">
                Save scoring rules
              </button>
            </div>
          ) : null}
        </form>
      </Panel>
    </>
  );
}
