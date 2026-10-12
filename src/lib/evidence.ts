import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { evidence } from "@/db/schema";
import type { EvidenceType } from "@/domain/constants";
import { evidenceStore } from "./storage";

/** Uploads a screenshot to object storage and records only its metadata in Postgres. */
export async function saveScreenshot(args: {
  dealershipId: string;
  type: EvidenceType;
  body: Buffer;
  sourceUrl: string | null;
  observationId?: string | null;
  interactionId?: string | null;
  capturedAt?: Date;
  /** image/jpeg (default) or image/png — for screenshots an operator uploads. */
  contentType?: "image/jpeg" | "image/png" | "audio/mpeg";
}): Promise<{ id: string; storageUrl: string }> {
  const capturedAt = args.capturedAt ?? new Date();
  const contentType = args.contentType ?? "image/jpeg";
  const key = `dealerships/${args.dealershipId}/${capturedAt.toISOString().slice(0, 10)}/${args.type.toLowerCase()}-${randomUUID()}.${contentType === "image/png" ? "png" : contentType === "audio/mpeg" ? "mp3" : "jpg"}`;
  const stored = await evidenceStore().put(key, args.body, contentType);
  const [row] = await db()
    .insert(evidence)
    .values({
      dealershipId: args.dealershipId,
      interactionId: args.interactionId ?? null,
      observationId: args.observationId ?? null,
      type: args.type,
      storageKey: stored.key,
      storageUrl: stored.url,
      contentType,
      bytes: args.body.byteLength,
      sourceUrl: args.sourceUrl,
      capturedAt,
    })
    .returning({ id: evidence.id });
  if (!row) throw new Error("Failed to record evidence");
  return { id: row.id, storageUrl: stored.url };
}
