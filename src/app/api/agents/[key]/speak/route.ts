import { AGENT_KEYS, type AgentKey } from "@/domain/agents";
import { AGENT_VOICE } from "@/domain/agent-voice";
import { getSessionUser } from "@/lib/auth/session";
import { synthesizeNeural } from "@/lib/speech-neural";
import { synthesizeWav } from "@/lib/speech-windows";

export const dynamic = "force-dynamic";

/** Speaks a line in the agent's voice using the server's speech engine. 204 when none is available. */
export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  if (!(await getSessionUser())) return new Response("Unauthorized", { status: 401 });
  const { key } = await params;
  if (!AGENT_KEYS.includes(key as AgentKey)) return new Response("Unknown agent", { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { text?: string };
  const text = String(body.text ?? "").trim();
  if (!text) return new Response("Nothing to say", { status: 400 });
  const voice = AGENT_VOICE[key as AgentKey];
  const neural = await synthesizeNeural(text, voice.neural);
  if (neural) return new Response(new Uint8Array(neural.mp3), { headers: { "content-type": "audio/mpeg", "cache-control": "no-store", "x-voice": `${neural.provider}:${neural.voice}` } });
  const wav = await synthesizeWav(text, voice.windows);
  if (!wav) return new Response(null, { status: 204 });
  return new Response(new Uint8Array(wav), { headers: { "content-type": "audio/wav", "cache-control": "no-store", "x-voice": "windows" } });
}
