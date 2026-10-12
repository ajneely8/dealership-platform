import type { AgentKey, AgentStatus } from "@/domain/agents";
import type { EventKind } from "@/lib/agent-events";

/** One agent_events row as the browser sees it. `demo` is set only by demo mode and never stored. */
export type FeedEvent = {
  id: string;
  at: string;
  agent: AgentKey | string;
  kind: EventKind | string;
  step: string;
  detail: string | null;
  status: string;
  dealershipId: string | null;
  dealershipName: string | null;
  interactionId: string | null;
  evidenceId: string | null;
  jobRunId: string | null;
  demo?: boolean;
};

export type CurrentTask = { jobRunId: string; queue: string; dealershipId: string | null; dealershipName: string | null; startedAt: string; lastStep: string | null };

export type AgentSnapshot = { key: AgentKey; status: AgentStatus; waiting: number; queued: number; current: CurrentTask | null };

/** One dealership Charlie has worked: what answered the phone and how the chatbot did. Both from stored records. */
export type CharlieDealership = {
  dealershipId: string;
  dealershipName: string;
  at: string;
  call: { verdict: string; note: string | null; heard: string | null; at: string } | null;
  chat: { grade: string | null; score: number | null; status: string; firstResponseSeconds: number | null; at: string; lines: { speaker: string; message: string }[] } | null;
};

/** Facts each scene draws with. Everything here is read from the database (or marked demo). */
export type SceneData =
  | { kind: "nova"; site: { dealershipName: string; url: string | null; chatVendor: string | null; chatPresent: boolean | null; leadFormCount: number | null; inventoryCount: number | null; serviceMode: string | null; mobileFriendly: boolean | null; websiteStatus: string | null; scannedAt: string } | null }
  | { kind: "charlie"; test: { id: string; dealershipName: string; testType: string; status: string; submittedAt: string | null; firstResponseSeconds: number | null } | null; transcript: { speaker: string; message: string; at: string }[]; recent: CharlieDealership[] }
  | { kind: "sage"; cards: { id: string; dealershipName: string; platform: string; followers: number | null; posts: number | null; questions: number | null; unanswered: number | null; note: string | null; at: string }[] }
  | { kind: "hunter"; signals: { id: string; dealershipName: string | null; title: string; type: string; at: string }[] }
  | { kind: "atlas"; target: { dealershipName: string; priority: number; recommended: string | null; scores: { product: string; score: number }[]; observed: number; inferred: number } | null }
  | { kind: "blaze"; brief: { dealershipName: string; priority: number; product: string | null; mainProblem: string | null; salesAngle: string | null; opener: string | null; question: string | null; nextAction: string | null; claims: { text: string; kind: string }[]; generatedAt: string } | null }
  | { kind: "orion"; queues: { queue: string; agent: AgentKey; waiting: number; active: number; delayed: number; paused: boolean }[]; window: { open: boolean; label: string } }
  | { kind: "echo"; open: { id: string; dealershipName: string; testType: string; submittedAt: string; firstResponseSeconds: number | null }[]; channels: { EMAIL: number; SMS: number; PHONE: number; CHAT: number } }
  | { kind: "sentinel"; coverage: { estimated: number; total: number }; latest: EstimateRow[] };

/** One stored estimate, as Sentinel's scene and overview show it. */
export type EstimateRow = { dealershipId: string; dealershipName: string; unitsLow: number; unitsHigh: number; grossLow: number | null; grossHigh: number | null; profitLow: number | null; profitHigh: number | null; profitPerUnit: number | null; segment: string | null; method: string; confidence: string; onHand: number | null; at: string };

export type SceneProps = {
  agentKey: AgentKey;
  status: AgentStatus;
  current: CurrentTask | null;
  /** Newest first. In replay, only the events played so far. */
  events: FeedEvent[];
  data: SceneData | null;
  reduced: boolean;
  demo: boolean;
};
