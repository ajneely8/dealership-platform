import { eq } from "drizzle-orm";
import { db } from "@/db";
import { evidence } from "@/db/schema";
import { getSessionUser } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { evidenceStore } from "@/lib/storage";

export const dynamic = "force-dynamic";

/** Streams a stored screenshot to signed-in users. Storage credentials and bucket URLs never reach the browser. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getSessionUser())) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const [row] = await db().select().from(evidence).where(eq(evidence.id, id)).limit(1);
  if (!row) return new Response("Not found", { status: 404 });
  try {
    const file = await evidenceStore().get(row.storageKey);
    return new Response(new Uint8Array(file.body), {
      headers: { "content-type": row.contentType, "cache-control": "private, max-age=3600", "content-disposition": "inline", "x-content-type-options": "nosniff" },
    });
  } catch (err) {
    logger.error({ err: (err as Error).message, evidenceId: id }, "evidence file could not be read");
    return new Response("The stored file could not be read.", { status: 502 });
  }
}
