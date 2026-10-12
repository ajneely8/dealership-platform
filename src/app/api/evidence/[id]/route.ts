import { eq } from "drizzle-orm";
import { db } from "@/db";
import { evidence } from "@/db/schema";
import { getSessionUser } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { evidenceStore } from "@/lib/storage";
import { queuesAvailable } from "@/queue";

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
    if (!queuesAvailable()) {
      // Hosted viewer: the file lives on the research machine. Images get a labelled placeholder.
      if (row.contentType.startsWith("image/")) {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400"><rect width="600" height="400" fill="#0a0d16"/><rect x="20" y="20" width="560" height="360" fill="none" stroke="#2a3650" stroke-dasharray="6 6"/><text x="300" y="190" fill="#8da2c0" font-family="system-ui, sans-serif" font-size="20" text-anchor="middle">${row.type.toLowerCase().replace(/_/g, " ")} screenshot</text><text x="300" y="222" fill="#5b6b86" font-family="system-ui, sans-serif" font-size="15" text-anchor="middle">stored on the research machine</text></svg>`;
        return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "private, max-age=3600" } });
      }
      return new Response("This recording is stored on the research machine and is not available in the hosted viewer.", { status: 404 });
    }
    logger.error({ err: (err as Error).message, evidenceId: id }, "evidence file could not be read");
    return new Response("The stored file could not be read.", { status: 502 });
  }
}
