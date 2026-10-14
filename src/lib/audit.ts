import { db } from "@/db";
import { auditLogs } from "@/db/schema";

export type AuditAction =
  | "phone.checked"
  | "dealership.testing_approved"
  | "prospect.admitted"
  | "prospect.rejected"
  | "relay.finished"
  | "test.requested"
  | "test.approved"
  | "test.cancelled"
  | "test.submitted"
  | "test.skipped"
  | "interaction.triggered"
  | "response.recorded"
  | "suppression.created"
  | "suppression.lifted"
  | "score.changed"
  | "dealership.created"
  | "dealership.updated"
  | "dealership.deleted"
  | "dealership.merged"
  | "dealership.imported"
  | "dealership.paused"
  | "dealership.testing_approval"
  | "dealership.pipeline"
  | "dealership.sales_touch"
  | "dealership.ownership"
  | "dealership.priority"
  | "group.created"
  | "group.updated"
  | "group.deleted"
  | "identity.created"
  | "identity.updated"
  | "settings.changed"
  | "job.enqueued"
  | "job.retried"
  | "signal.created"
  | "social.recorded"
  | "contact.created"
  | "user.login"
  | "user.created";

export async function audit(
  actor: string,
  action: AuditAction,
  entity: string,
  entityId: string | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await db().insert(auditLogs).values({ actor, action, entity, entityId, metadata });
}
