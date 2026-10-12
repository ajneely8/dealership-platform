import type { AgentKey } from "@/domain/agents";

/**
 * How each agent sounds and speaks. Browser speech synthesis is used, so the exact voice depends
 * on the machine; the hints pick the closest installed voice and pitch/rate keep them apart.
 */
/**
 * `windows` drives the server's speech engine (gender picks David or Zira; pitch is an SSML
 * prosody value; rate is the engine's -10…10). `hints`/`pitch`/`rate` are the browser fallback.
 */
/**
 * `neural` names the realistic voice per provider. OpenAI's voices are literally called nova,
 * sage and echo; ElevenLabs has a Charlie and an Eric (Sentinel). The rest are picked to fit
 * the name and the role, and no two agents share a voice on either provider.
 */
export const AGENT_VOICE: Record<AgentKey, { hints: string[]; pitch: number; rate: number; style: string; windows: { gender: "Male" | "Female"; pitch: string; rate: number }; neural: { openai: string; elevenlabs: string; speed: number; style: string } }> = {
  nova: { hints: ["Microsoft Aria", "Google US English", "Samantha", "Zira"], pitch: 1.05, rate: 1.05, style: "precise and quick", windows: { gender: "Female", pitch: "+5%", rate: 1 }, neural: { openai: "nova", elevenlabs: "EXAVITQu4vr4xnSDxMaL", speed: 1.05, style: "precise, quick, upbeat" } },
  charlie: { hints: ["Microsoft Guy", "Google UK English Male", "Daniel", "David"], pitch: 0.95, rate: 1.0, style: "friendly and direct", windows: { gender: "Male", pitch: "+4%", rate: 0 }, neural: { openai: "ash", elevenlabs: "IKne3meq5aSn9XLyUdCD", speed: 1.0, style: "friendly, direct" } },
  sage: { hints: ["Microsoft Jenny", "Google UK English Female", "Karen", "Zira"], pitch: 1.1, rate: 0.98, style: "calm and observant", windows: { gender: "Female", pitch: "-4%", rate: -1 }, neural: { openai: "sage", elevenlabs: "XrExE9yKIg1WjnnlVkGX", speed: 0.97, style: "calm, observant" } },
  hunter: { hints: ["Microsoft Davis", "Google US English", "Alex", "David"], pitch: 0.85, rate: 1.0, style: "brisk", windows: { gender: "Male", pitch: "-6%", rate: 1 }, neural: { openai: "onyx", elevenlabs: "iP95p4xoKVk53GoZ742B", speed: 1.03, style: "brisk, focused" } },
  atlas: { hints: ["Microsoft Mark", "Fred", "David"], pitch: 0.8, rate: 0.95, style: "measured, numbers first", windows: { gender: "Male", pitch: "-12%", rate: -1 }, neural: { openai: "fable", elevenlabs: "JBFqnCBsd6RMkjVDRZzb", speed: 0.95, style: "measured, numbers first" } },
  blaze: { hints: ["Microsoft Ryan", "Google UK English Male", "Daniel"], pitch: 1.0, rate: 1.08, style: "upbeat, sales-minded", windows: { gender: "Male", pitch: "+10%", rate: 2 }, neural: { openai: "verse", elevenlabs: "nPczCjzI2devNBz1zQrb", speed: 1.08, style: "upbeat, sales-minded" } },
  orion: { hints: ["Microsoft Christopher", "Google US English", "Alex"], pitch: 0.9, rate: 0.95, style: "steady, coordinating", windows: { gender: "Male", pitch: "0%", rate: -1 }, neural: { openai: "alloy", elevenlabs: "onwK4e9ZLuTAKqWW03F9", speed: 0.97, style: "steady, coordinating" } },
  echo: { hints: ["Microsoft Michelle", "Google UK English Female", "Moira", "Zira"], pitch: 1.15, rate: 1.0, style: "attentive", windows: { gender: "Female", pitch: "+12%", rate: 0 }, neural: { openai: "echo", elevenlabs: "pFZP5JQG7iQjIQuC4Bku", speed: 1.0, style: "attentive, clear" } },
  sentinel: { hints: ["Microsoft Eric", "Daniel", "David"], pitch: 0.75, rate: 0.9, style: "firm and brief", windows: { gender: "Male", pitch: "-18%", rate: -2 }, neural: { openai: "ballad", elevenlabs: "cjVigY5qzO86Huf0OWal", speed: 0.93, style: "firm, brief" } },
};

export type BriefingFacts = {
  agentName: string;
  role: string;
  status: string;
  current: { step: string | null; dealership: string | null; queue: string; seconds: number } | null;
  today: { completed: number; failed: number; skipped: number };
  recent: { at: string; step: string; dealership: string | null; status: string }[];
  dealerships: { name: string; lastStep: string; at: string }[];
};

/** Facts arrive with times already formatted for the operator's time zone. */
const timeOf = (at: string) => (Number.isNaN(Date.parse(at)) ? at : new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }));

/**
 * A spoken answer built only from recorded facts. Used when no AI provider is configured, and as
 * the fallback whenever the AI answer cannot be grounded. Recognises the questions people
 * actually ask an agent: what are you doing, what have you done, how is it going, what about X.
 */
export function answerFromFacts(question: string, f: BriefingFacts): string {
  const q = question.toLowerCase();
  const name = f.agentName;
  const mention = f.dealerships.find((d) => q.includes(d.name.toLowerCase().split(" ")[0] ?? "\u0000") && d.name.length > 3);
  if (mention) {
    const steps = f.recent.filter((r) => r.dealership === mention.name).slice(0, 4);
    return steps.length ? `${mention.name}: ${steps.map((s) => `${s.step} at ${timeOf(s.at)}`).join(". ")}.` : `I last worked on ${mention.name} at ${timeOf(mention.at)}: ${mention.lastStep}.`;
  }
  if (/\b(history|been doing|have you done|did you do|what happened|recap|report|brief)\b/.test(q) || q.trim().length === 0) {
    const lines = f.recent.slice(0, 6).map((r) => `${timeOf(r.at)}: ${r.step}${r.dealership ? ` for ${r.dealership}` : ""}`);
    return lines.length ? `Here's what I've been doing. ${lines.join(". ")}.` : `I'm ${name}, ${f.role.toLowerCase()}. I have not recorded any steps yet.`;
  }
  if (/\b(right now|currently|at the moment|what are you doing|working on now|up to)\b/.test(q) || /^what('s| is| are you) doing\??$/.test(q.trim())) {
    if (f.current) return `Right now I'm ${f.current.step ? f.current.step.toLowerCase() : `running ${f.current.queue}`}${f.current.dealership ? ` for ${f.current.dealership}` : ""}, ${f.current.seconds} seconds in.`;
    return `Nothing is running at the moment. ${f.recent[0] ? `My last step was: ${f.recent[0].step}${f.recent[0].dealership ? ` for ${f.recent[0].dealership}` : ""}, at ${timeOf(f.recent[0].at)}.` : "I have not recorded any steps yet."}`;
  }
  if (/\b(today|so far|how many|count|numbers|stats|summary|how.*going)\b/.test(q)) {
    return `Today I've completed ${f.today.completed} task${f.today.completed === 1 ? "" : "s"}${f.today.failed ? `, ${f.today.failed} failed` : ""}${f.today.skipped ? `, ${f.today.skipped} skipped by policy` : ""}. ${f.dealerships.length ? `I've touched ${f.dealerships.length} dealership${f.dealerships.length === 1 ? "" : "s"} recently, most recently ${f.dealerships[0]!.name}.` : ""}`.trim();
  }
  if (/\b(who are you|what do you do|your job|role)\b/.test(q)) return `I'm ${name}, the ${f.role.toLowerCase()}. My status is ${f.status.toLowerCase()}.`;
  if (/\b(fail|error|problem|wrong|stuck)\b/.test(q)) {
    const bad = f.recent.filter((r) => r.status === "ERROR" || r.status === "BLOCKED").slice(0, 4);
    return bad.length ? `Recent problems: ${bad.map((b) => `${b.step}${b.dealership ? ` (${b.dealership})` : ""} at ${timeOf(b.at)}`).join("; ")}.` : "No errors or blocks in my recent steps.";
  }
  return `I can only answer from what I've recorded. ${f.recent[0] ? `My latest step: ${f.recent[0].step}${f.recent[0].dealership ? ` for ${f.recent[0].dealership}` : ""}, at ${timeOf(f.recent[0].at)}.` : "Nothing is recorded yet."} Ask me what I'm doing now, what I've been doing, today's numbers, or about a dealership by name.`;
}
