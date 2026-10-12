import type { QueueName } from "./constants";

/**
 * The nine agents the sales team sees. Each one is a face on existing workers: the queues listed
 * here are the real work it does, and its status, activity and history are read from the jobs and
 * events those queues produce. Nothing here is a separate "AI" — it is how the system is explained.
 */
export const AGENT_KEYS = ["nova", "charlie", "sage", "hunter", "atlas", "blaze", "orion", "echo", "sentinel"] as const;
export type AgentKey = (typeof AGENT_KEYS)[number];

export type AgentDef = {
  key: AgentKey;
  number: string;
  name: string;
  role: string;
  /** CSS colour token for rings, bars and badges. */
  color: string;
  purpose: string;
  capabilities: string[];
  /** Queues whose jobs belong to this agent. Empty for agents that act through rules rather than jobs. */
  queues: readonly QueueName[];
  /** Position of this agent's portrait in public/agents.webp (3×3 grid). */
  avatar: { col: 0 | 1 | 2; row: 0 | 1 | 2 };
  /** Where its configuration lives. */
  configHref: string;
};

export const AGENTS: Record<AgentKey, AgentDef> = {
  nova: {
    key: "nova",
    number: "01",
    name: "Nova",
    role: "Website Intelligence Agent",
    color: "#1e78ff",
    purpose: "Research dealership websites and identify weaknesses in their digital customer experience.",
    capabilities: [
      "Visit dealership websites with a polite, identified browser",
      "Read the dealership's own name, phone, address and brands",
      "Detect chat widgets and identify the vendor",
      "Find and classify lead forms",
      "Count new and used inventory and look for alert sign-ups",
      "Check the service page and how service is booked",
      "Check the mobile experience",
      "Collect social profile links and the careers page",
      "Identify the website platform and marketing technology",
      "Capture screenshots as evidence",
    ],
    queues: ["prospect", "discovery", "website-scan"],
    avatar: { col: 0, row: 0 },
    configHref: "/settings",
  },
  charlie: {
    key: "charlie",
    number: "02",
    name: "Charlie",
    role: "Chat & Form Testing Agent",
    color: "#ff8a1f",
    purpose: "Test dealership customer communication systems using controlled, authorised interactions.",
    capabilities: [
      "Submit one approved inquiry through a lead form, as a company-owned identity",
      "Open the chat widget and ask one approved question",
      "Give name, email and phone when a widget insists, and nothing else",
      "Start the response timer at the moment of submission",
      "Capture the transcript and screenshots",
      "Record every reply with its channel and timing",
      "Never book, apply for finance, claim urgency or send a second message",
    ],
    queues: ["interaction", "phone-check"],
    avatar: { col: 1, row: 0 },
    configHref: "/settings",
  },
  sage: {
    key: "sage",
    number: "03",
    name: "Sage",
    role: "Social Media Intelligence Agent",
    color: "#9b5cff",
    purpose: "Read the dealership's public social presence and flag where customer questions may be going unanswered.",
    capabilities: [
      "Find the dealership's profiles from its own website",
      "Read follower and post counts a profile shows without signing in",
      "Record when a platform shows a sign-in wall instead",
      "Keep operator-recorded activity, questions and unanswered comments, each with a source",
      "Never read private messages or work around a login",
    ],
    queues: ["social"],
    avatar: { col: 2, row: 0 },
    configHref: "/settings",
  },
  hunter: {
    key: "hunter",
    number: "04",
    name: "Hunter",
    role: "Hiring & Business Signals Agent",
    color: "#22c55e",
    purpose: "Spot growth: hiring for sales, intake and marketing roles, new locations, leadership changes.",
    capabilities: [
      "Read open positions from the dealership's careers page",
      "Keep only growth and intake roles: sales, BDC, internet sales, receptionist, marketing, service advisors",
      "Ignore shop-floor jobs such as technicians and porters",
      "Store every signal with its source link and observation date",
      "Accept operator-entered signals (expansion, acquisitions, advertising) with a source",
    ],
    queues: ["signals"],
    avatar: { col: 0, row: 1 },
    configHref: "/settings",
  },
  atlas: {
    key: "atlas",
    number: "05",
    name: "Atlas",
    role: "Opportunity Scoring Agent",
    color: "#f5b921",
    purpose: "Turn everything the other agents found into four product-fit scores and one priority, with reasons.",
    capabilities: [
      "Score SummaryBot, Inventory Outreach, Service Bot and Social DM Automation from 0 to 100",
      "Use fixed, editable rules — never a model's guess",
      "Attach the evidence behind every point",
      "Mark each reason as observed or inferred, with a confidence",
      "Leave unknown things unscored rather than counting them as failures",
      "Roll rooftops up to their dealer group",
    ],
    queues: ["scoring"],
    avatar: { col: 1, row: 1 },
    configHref: "/settings#scoring",
  },
  blaze: {
    key: "blaze",
    number: "06",
    name: "Blaze",
    role: "Sales Intelligence Agent",
    color: "#ef3b3b",
    purpose: "Turn research into a call brief a salesperson can use in the next five minutes.",
    capabilities: [
      "Recommend the product and the role to ask for",
      "Write the sales angle, a cold-call opener and a discovery question",
      "Tie every claim in the brief to stored evidence",
      "Reject any AI wording that adds a number the evidence does not contain",
      "Suggest the next action",
    ],
    queues: ["sales-intel"],
    avatar: { col: 2, row: 1 },
    configHref: "/settings",
  },
  orion: {
    key: "orion",
    number: "07",
    name: "SarvX",
    role: "Master Orchestrator Agent",
    color: "#7dd3fc",
    purpose: "Coordinate the workforce: schedule research, keep it inside the research window, and keep queues healthy.",
    capabilities: [
      "Schedule website, inventory, careers and social research on their cadences",
      "Keep research inside the daily window and park work that arrives outside it",
      "Prevent duplicate jobs with deterministic job ids",
      "Retry transient failures with backoff; surface persistent ones",
      "Pause and resume any agent",
      "Track AI spend per job",
    ],
    queues: [],
    avatar: { col: 0, row: 2 },
    configHref: "/agents",
  },
  echo: {
    key: "echo",
    number: "08",
    name: "Echo",
    role: "Response Monitoring Agent",
    color: "#06b6d4",
    purpose: "Watch the company-owned inbox, number and chat for dealership replies, around the clock.",
    capabilities: [
      "Receive email, SMS and phone events through authenticated webhooks",
      "Match each reply to the open test it belongs to",
      "Stop the first-response timer and keep recording later replies",
      "Classify replies as automated or human by text rules, then AI if configured",
      "Check the 5 min, 15 min, 1 h, 4 h, 24 h and 72 h milestones",
      "Park anything it cannot attribute for a person to resolve",
    ],
    queues: ["response-check"],
    avatar: { col: 1, row: 2 },
    configHref: "/settings",
  },
  sentinel: {
    key: "sentinel",
    number: "09",
    name: "Sentinel",
    role: "Revenue & Volume Estimate Agent",
    color: "#f2c14e",
    purpose: "Estimate how many vehicles each dealership sells a month and what that is worth, from its own inventory.",
    capabilities: [
      "Read every dealership's inventory pages: vehicles on the lot and their asking prices",
      "Count listings that leave the lot between weekly snapshots as sold, scaled to the lot",
      "Give a first estimate from lot size the day a dealership arrives, then replace it with measured turnover",
      "Estimate gross monthly vehicle sales as units sold times the median asking price",
      "Carry a confidence level that rises as the observed window passes two and four weeks",
      "Refuse to estimate from marketing numbers: lots above 1,500 are treated as not counted",
      "Write the estimate on the dealership so every list, card and brief shows it",
    ],
    queues: ["inventory", "estimate"],
    avatar: { col: 2, row: 2 },
    configHref: "/settings",
  },
};

export function agentForQueue(queue: QueueName): AgentKey {
  for (const a of Object.values(AGENTS)) if (a.queues.includes(queue)) return a.key;
  return "orion";
}

export const AGENT_STATUSES = ["WORKING", "WAITING", "SCHEDULED", "PAUSED", "ERROR", "COMPLETED", "IDLE"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  WORKING: "Working",
  WAITING: "Waiting for response",
  SCHEDULED: "Scheduled",
  PAUSED: "Paused",
  ERROR: "Error",
  COMPLETED: "Completed",
  IDLE: "Idle",
};

/**
 * Status from real state, in priority order: paused beats everything, then a running job, then a
 * monitored test (Echo), then parked/queued work, then a failure as the last thing that happened.
 */
export function deriveAgentStatus(input: { paused: boolean; running: number; waitingReplies: number; queued: number; lastOutcome: "COMPLETED" | "FAILED" | "SKIPPED" | null; lastAt: Date | null; now?: Date }): AgentStatus {
  const now = input.now ?? new Date();
  if (input.paused) return "PAUSED";
  if (input.running > 0) return "WORKING";
  if (input.waitingReplies > 0) return "WAITING";
  if (input.queued > 0) return "SCHEDULED";
  if (input.lastOutcome === "FAILED") return "ERROR";
  if (input.lastOutcome === "COMPLETED" && input.lastAt && now.getTime() - input.lastAt.getTime() < 10 * 60_000) return "COMPLETED";
  return "IDLE";
}
