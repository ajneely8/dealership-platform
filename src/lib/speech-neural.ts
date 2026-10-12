import { env } from "@/env";
import { logger } from "@/lib/logger";

/**
 * Realistic (neural) voices from a provider the operator holds a key for. Chosen by
 * TTS_PROVIDER, or automatically by whichever key is present (OpenAI first, then ElevenLabs).
 * Returns MP3 bytes, or null when no provider is configured or the call fails — the caller then
 * falls back to the Windows engine.
 */

export type NeuralVoice = { openai: string; elevenlabs: string; speed: number; style: string };

export function neuralProvider(): "openai" | "elevenlabs" | null {
  const e = env();
  const pick = e.TTS_PROVIDER ?? "auto";
  if (pick === "openai" && e.OPENAI_API_KEY) return "openai";
  if (pick === "elevenlabs" && e.ELEVENLABS_API_KEY) return "elevenlabs";
  if (pick === "auto") {
    if (e.OPENAI_API_KEY) return "openai";
    if (e.ELEVENLABS_API_KEY) return "elevenlabs";
  }
  return null;
}

export async function synthesizeNeural(text: string, voice: NeuralVoice): Promise<{ mp3: Buffer; provider: string; voice: string } | null> {
  const provider = neuralProvider();
  if (!provider) return null;
  const e = env();
  const input = text.slice(0, 2000);
  try {
    if (provider === "openai") {
      const res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { authorization: `Bearer ${e.OPENAI_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: e.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts", voice: voice.openai, input, speed: voice.speed, instructions: `Speak as a ${voice.style} colleague giving a quick spoken update. Natural, conversational, no theatrics.`, response_format: "mp3" }),
      });
      if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return { mp3: Buffer.from(await res.arrayBuffer()), provider, voice: voice.openai };
    }
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice.elevenlabs}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": e.ELEVENLABS_API_KEY!, "content-type": "application/json" },
      body: JSON.stringify({ text: input, model_id: "eleven_turbo_v2_5", voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.2, speed: voice.speed } }),
    });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { mp3: Buffer.from(await res.arrayBuffer()), provider, voice: voice.elevenlabs };
  } catch (err) {
    logger.warn({ err: (err as Error).message, provider }, "neural voice failed; falling back to the Windows engine");
    return null;
  }
}
