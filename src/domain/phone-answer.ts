import type { ReceptionistStatus } from "@/domain/constants";

/**
 * What answered the dealership's phone, decided from the call's answering-machine detection and
 * the transcript of the first seconds. Deterministic; every verdict names the phrase it rests on.
 */

export type AnsweredBy = "human" | "machine_start" | "machine_end_beep" | "machine_end_silence" | "machine_end_other" | "fax" | "unknown" | null;

const AI_PHRASES = /\b(virtual (assistant|receptionist|agent)|ai (assistant|receptionist|agent)|automated assistant|digital assistant|i('m| am) an? (ai|automated|virtual)|powered by (ai|artificial)|smart assistant|voice assistant)\b/i;
const IVR_PHRASES = /\b(press (one|two|three|1|2|3)|for (sales|service|parts),? press|to reach|main menu|say or enter|dial (the )?extension|if you know your party'?s extension|para español)\b/i;
const VOICEMAIL_PHRASES = /\b(leave (a|your) message|after the (tone|beep)|not available (to take|right now)|we('re| are) (currently )?closed|our (business )?hours are|mailbox|voicemail|can'?t come to the phone)\b/i;
const HUMAN_GREETING = /\b(thank(s| you) for calling|this is \w+|how (can|may) i help|speaking|good (morning|afternoon|evening))\b/i;

export type PhoneVerdict = { status: ReceptionistStatus; confidence: "HIGH" | "MEDIUM" | "LOW"; reason: string };

export function classifyPhoneAnswer(input: { callStatus: string; answeredBy: AnsweredBy; transcript: string | null; durationSeconds: number | null; hungUpOnHuman?: boolean; rings?: number | null }): PhoneVerdict {
  const t = (input.transcript ?? "").replace(/\s+/g, " ").trim();
  const after = input.rings ? ` after ${input.rings} ring${input.rings === 1 ? "" : "s"}` : "";
  if (input.hungUpOnHuman) return { status: "HUMAN", confidence: "HIGH", reason: `a person answered${after}; the call was ended before anything was said` };
  if (["no-answer", "busy", "failed", "canceled"].includes(input.callStatus)) return { status: "NO_ANSWER", confidence: "HIGH", reason: `call ended with status ${input.callStatus}` };
  if (t) {
    const ai = AI_PHRASES.exec(t);
    if (ai) return { status: "AI_RECEPTIONIST", confidence: "HIGH", reason: `said "${ai[0]}"` };
    const ivr = IVR_PHRASES.exec(t);
    if (ivr) return { status: "IVR_MENU", confidence: "HIGH", reason: `said "${ivr[0]}"` };
    const vm = VOICEMAIL_PHRASES.exec(t);
    if (vm) return { status: "VOICEMAIL", confidence: "HIGH", reason: `said "${vm[0]}"` };
    const human = HUMAN_GREETING.exec(t);
    if (human && input.answeredBy !== "machine_end_beep") return { status: "HUMAN", confidence: input.answeredBy === "human" ? "HIGH" : "MEDIUM", reason: `greeting "${human[0]}"${input.answeredBy === "human" ? " and the line detected a person" : ""}` };
  }
  switch (input.answeredBy) {
    case "human":
      return { status: "HUMAN", confidence: t ? "MEDIUM" : "LOW", reason: t ? "the line detected a person; no recognisable phrase" : "the line detected a person; nothing transcribed" };
    case "machine_end_beep":
      return { status: "VOICEMAIL", confidence: "MEDIUM", reason: "a recorded greeting ended with a beep" };
    case "machine_start":
    case "machine_end_silence":
    case "machine_end_other":
      return { status: t ? "IVR_MENU" : "VOICEMAIL", confidence: "LOW", reason: "a recording answered; the words were not recognisable" };
    case "fax":
      return { status: "NO_ANSWER", confidence: "HIGH", reason: "a fax line answered" };
    default:
      return { status: "UNKNOWN", confidence: "LOW", reason: input.durationSeconds ? `answered for ${input.durationSeconds}s; nothing could be classified` : "nothing could be classified" };
  }
}
