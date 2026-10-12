import { AGENT_KEYS, type AgentKey } from "@/domain/agents";
import { getSessionUser } from "@/lib/auth/session";
import { recognizeWav } from "@/lib/speech-windows";

export const dynamic = "force-dynamic";

/** Turns a short WAV recording (16 kHz mono PCM) into text with the server's speech recognizer. */
export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  if (!(await getSessionUser())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { key } = await params;
  if (!AGENT_KEYS.includes(key as AgentKey)) return Response.json({ error: "Unknown agent" }, { status: 404 });
  const bytes = Buffer.from(await req.arrayBuffer());
  if (bytes.length < 1000) return Response.json({ error: "The recording was empty." }, { status: 400 });
  if (bytes.length > 8_000_000) return Response.json({ error: "The recording is too long." }, { status: 413 });
  const text = await recognizeWav(bytes);
  if (text === null) return Response.json({ error: "Speech recognition is not available on this server." }, { status: 503 });
  return Response.json({ text });
}
