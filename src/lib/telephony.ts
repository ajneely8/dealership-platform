import { env } from "@/env";
import type { AnsweredBy } from "@/domain/phone-answer";
import { recognizeWav } from "./speech-windows";

/**
 * Twilio Programmable Voice through its REST API, polled — no public webhook URL is needed, so it
 * works from a workstation. One call per check:
 *
 *   1. dial with answering-machine detection on; poll the call every second
 *   2. ringing → answered: the ring time is measured (US phones ring about every 6 s)
 *   3. a PERSON answers → hang up at once (if `hangUpOnHuman`), nothing is said to them
 *   4. anything else (AI receptionist, phone menu, voicemail) → whatever answers is recorded
 *      from the first second for up to `recordSeconds`, then the call ends. Charlie says
 *      nothing, so no message is ever left on a dealership's voicemail; the greeting itself is
 *      the evidence, transcribed by Twilio or, failing that, locally.
 *
 * Not configured until TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER are set.
 */

const API = "https://api.twilio.com/2010-04-01";
const RING_SECONDS = 6;

export function twilioConfigured(): boolean {
  const e = env();
  return Boolean(e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && e.TWILIO_FROM_NUMBER);
}

function auth() {
  const e = env();
  return "Basic " + Buffer.from(`${e.TWILIO_ACCOUNT_SID}:${e.TWILIO_AUTH_TOKEN}`).toString("base64");
}

async function twilio<T>(path: string, init: { method?: string; form?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(`${API}/Accounts/${env().TWILIO_ACCOUNT_SID}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: auth(), ...(init.form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body: init.form ? new URLSearchParams(init.form).toString() : undefined,
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** OpenAI Whisper transcription of a WAV, or null when no OpenAI key is configured or the call fails. */
async function transcribeWithWhisper(wav: Buffer): Promise<string | null> {
  const key = env().OPENAI_API_KEY;
  if (!key) return null;
  try {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "call.wav");
    form.append("model", "whisper-1");
    form.append("language", "en");
    form.append("prompt", "Dealership phone greeting, voicemail, phone menu or virtual assistant.");
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form });
    if (!res.ok) return null;
    const j = (await res.json()) as { text?: string };
    return j.text?.trim() || null;
  } catch {
    return null;
  }
}

export type CallOutcome = {
  callSid: string;
  status: string;
  answeredBy: AnsweredBy;
  durationSeconds: number | null;
  /** Seconds between the line starting to ring and it being answered, and the rings that implies. */
  ringSeconds: number | null;
  rings: number | null;
  /** True when a person answered and the call was ended before anything was said. */
  hungUpOnHuman: boolean;
  recordingSid: string | null;
  recording: Buffer | null;
  transcript: string | null;
};

type CallResource = { sid: string; status: string; answered_by: string | null; duration: string | null; date_created?: string; start_time?: string | null };

/** Places the call and drives it as described above. */
export async function placeScriptedCall(args: { to: string; script: string; recordSeconds?: number; timeoutSeconds?: number; hangUpOnHuman?: boolean }): Promise<CallOutcome> {
  const e = env();
  const recordSeconds = Math.min(90, Math.max(15, args.recordSeconds ?? 45));
  const hangUpOnHuman = args.hangUpOnHuman ?? true;
  // Recording starts the moment the call is answered; machine detection runs alongside it
  // (AsyncAmd) and shows up on the call resource, where the poll below reads it.
  void xml;
  void args.script;
  const twiml = `<Response><Record maxLength="${recordSeconds}" timeout="6" playBeep="false" transcribe="true"/><Hangup/></Response>`;
  const call = await twilio<{ sid: string }>("/Calls.json", {
    method: "POST",
    form: { To: args.to, From: e.TWILIO_FROM_NUMBER!, Twiml: twiml, MachineDetection: "Enable", AsyncAmd: "true", MachineDetectionTimeout: "15", Timeout: String(args.timeoutSeconds ?? 30) },
  });

  const deadline = Date.now() + 4 * 60_000;
  let status = "queued";
  let answeredBy: AnsweredBy = null;
  let duration: number | null = null;
  let ringingAt: number | null = null;
  let answeredAt: number | null = null;
  let hungUpOnHuman = false;
  for (;;) {
    await sleep(1000);
    const c = await twilio<CallResource>(`/Calls/${call.sid}.json`);
    status = c.status;
    answeredBy = (c.answered_by as AnsweredBy) ?? answeredBy;
    duration = c.duration ? Number(c.duration) : duration;
    if (status === "ringing" && ringingAt === null) ringingAt = Date.now();
    if (status === "in-progress" && answeredAt === null) answeredAt = Date.now();
    if (status === "in-progress" && answeredBy === "human" && hangUpOnHuman && !hungUpOnHuman) {
      await twilio(`/Calls/${call.sid}.json`, { method: "POST", form: { Status: "completed" } }).catch(() => undefined);
      hungUpOnHuman = true;
    }
    if (["completed", "busy", "no-answer", "failed", "canceled"].includes(status) || Date.now() > deadline) break;
  }
  let ringSeconds = ringingAt !== null ? Math.round(((answeredAt ?? Date.now()) - ringingAt) / 1000) : null;
  if (ringSeconds === null) {
    // The poll can miss the ringing state on a quick answer; Twilio's created→start gap is the next best measure.
    const c = await twilio<CallResource>(`/Calls/${call.sid}.json`).catch(() => null);
    if (c?.date_created && c.start_time) ringSeconds = Math.max(0, Math.round((Date.parse(c.start_time) - Date.parse(c.date_created)) / 1000) - 1);
  }
  const rings = ringSeconds !== null ? Math.max(1, Math.ceil(ringSeconds / RING_SECONDS)) : null;

  let recordingSid: string | null = null;
  let recording: Buffer | null = null;
  let transcript: string | null = null;
  if (status === "completed" && !hungUpOnHuman) {
    await sleep(2000);
    const recs = await twilio<{ recordings: { sid: string; duration: string }[] }>(`/Recordings.json?CallSid=${call.sid}`);
    const rec = recs.recordings[0];
    if (rec) {
      recordingSid = rec.sid;
      const audio = await fetch(`${API}/Accounts/${e.TWILIO_ACCOUNT_SID}/Recordings/${rec.sid}.mp3`, { headers: { authorization: auth() } });
      if (audio.ok) recording = Buffer.from(await audio.arrayBuffer());
      // Twilio's transcription, if it comes within 45 s; otherwise the recording is transcribed locally.
      const tDeadline = Date.now() + 45_000;
      while (Date.now() < tDeadline) {
        const tr = await twilio<{ transcriptions: { status: string; transcription_text: string | null }[] }>(`/Recordings/${rec.sid}/Transcriptions.json`).catch(() => ({ transcriptions: [] }));
        const t = tr.transcriptions[0];
        if (t && t.status === "completed") {
          transcript = t.transcription_text;
          break;
        }
        if (t && t.status === "failed") break;
        await sleep(6000);
      }
      if (!transcript) {
        // Best available transcription for phone audio: OpenAI Whisper when a key is present, else the Windows recognizer.
        const wav = await fetch(`${API}/Accounts/${e.TWILIO_ACCOUNT_SID}/Recordings/${rec.sid}.wav`, { headers: { authorization: auth() } });
        if (wav.ok) {
          const bytes = Buffer.from(await wav.arrayBuffer());
          transcript = (await transcribeWithWhisper(bytes)) ?? (await recognizeWav(bytes)) ?? null;
        }
      }
    }
  }
  return { callSid: call.sid, status, answeredBy, durationSeconds: duration, ringSeconds, rings, hungUpOnHuman, recordingSid, recording, transcript };
}
