export const ROLES = ["ADMIN", "OPERATOR", "VIEWER"] as const;
export type Role = (typeof ROLES)[number];

export const PRODUCTS = ["SUMMARYBOT", "INVENTORY_OUTREACH", "SERVICE_BOT", "SOCIAL_AUTOMATION"] as const;
export type Product = (typeof PRODUCTS)[number];
export const PRODUCT_LABEL: Record<Product, string> = {
  SUMMARYBOT: "SummaryBot",
  INVENTORY_OUTREACH: "Inventory Outreach",
  SERVICE_BOT: "Service Bot",
  SOCIAL_AUTOMATION: "Social Automation",
};

export const PIPELINE_STAGES = [
  "RESEARCHING",
  "READY_TO_CONTACT",
  "CONTACTED",
  "REPLIED",
  "MEETING_BOOKED",
  "QUALIFIED",
  "PROPOSAL",
  "WON",
  "LOST",
  "SUPPRESSED",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Result of an operator phoning the dealership. */
export const RECEPTIONIST_STATUSES = ["UNKNOWN", "HUMAN", "AI_RECEPTIONIST", "IVR_MENU", "VOICEMAIL", "NO_ANSWER"] as const;
export type ReceptionistStatus = (typeof RECEPTIONIST_STATUSES)[number];
export const RECEPTIONIST_LABEL: Record<ReceptionistStatus, string> = {
  UNKNOWN: "Not checked",
  HUMAN: "A person answered",
  AI_RECEPTIONIST: "AI receptionist",
  IVR_MENU: "Phone menu (press 1 for…)",
  VOICEMAIL: "Voicemail",
  NO_ANSWER: "No answer",
};

export const SUPPRESSION_REASONS = [
  "CUSTOMER",
  "DO_NOT_CONTACT",
  "REQUESTED_REMOVAL",
  "ACTIVE_OPPORTUNITY",
  "RECENTLY_TESTED",
  "CLOSED_LOST",
  "LEGAL",
  "COMPLIANCE",
  "MANUAL",
  "OTHER",
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export const SUPPRESSION_SCOPES = ["DEALERSHIP", "GROUP", "DOMAIN", "PHONE"] as const;
export type SuppressionScope = (typeof SUPPRESSION_SCOPES)[number];

export const SIGNAL_TYPES = [
  "BDC_HIRING",
  "RECEPTIONIST_HIRING",
  "SALES_HIRING",
  "INTERNET_SALES_HIRING",
  "SERVICE_HIRING",
  "MARKETING_HIRING",
  "SOCIAL_MEDIA_HIRING",
  "CRM_HIRING",
  "AI_HIRING",
  "MANAGEMENT_CHANGE",
  "OWNERSHIP_CHANGE",
  "NEW_LOCATION",
  "EXPANSION",
  "ACQUISITION",
  "ADVERTISING_ACTIVITY",
  // Two additions to the base list so the Service Bot rules have a sourced signal to key on.
  "SERVICE_SCHEDULING_COMPLAINTS",
  "LARGE_SERVICE_OPERATION",
  "OTHER",
] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

/**
 * Hiring and business signals that say a dealership is growing or building intake capacity —
 * the ones that make it a fit for us. Technicians, porters and the like are deliberately absent.
 */
export const GROWTH_SIGNAL_TYPES: readonly SignalType[] = [
  "BDC_HIRING",
  "RECEPTIONIST_HIRING",
  "SALES_HIRING",
  "INTERNET_SALES_HIRING",
  "MARKETING_HIRING",
  "SOCIAL_MEDIA_HIRING",
  "CRM_HIRING",
  "AI_HIRING",
  "SERVICE_HIRING",
  "MANAGEMENT_CHANGE",
  "NEW_LOCATION",
  "EXPANSION",
  "ACQUISITION",
];

export const CONFIDENCE = ["HIGH", "MEDIUM", "LOW"] as const;
export type Confidence = (typeof CONFIDENCE)[number];

export const FINDING_KINDS = ["OBSERVED", "INFERENCE"] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export const EVIDENCE_TYPES = ["HOMEPAGE", "FORM", "CHAT", "INVENTORY", "SERVICE", "SOCIAL", "RESPONSE", "CALL", "OTHER"] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const CHANNELS = ["SMS", "EMAIL", "PHONE", "CHAT", "OTHER"] as const;
export type Channel = (typeof CHANNELS)[number];

export const FORM_TYPES = [
  "CONTACT",
  "VEHICLE_INQUIRY",
  "GET_INFORMATION",
  "CHECK_AVAILABILITY",
  "GENERAL_LEAD",
  "SERVICE_REQUEST",
  // Detected so we can refuse them. Never submitted.
  "FINANCE",
  "TRADE_IN",
  "TEST_DRIVE",
  "NEWSLETTER",
  "SEARCH",
  "OTHER",
] as const;
export type FormType = (typeof FORM_TYPES)[number];

/** The only form types the interaction worker is ever allowed to submit. */
export const SUBMITTABLE_FORM_TYPES: readonly FormType[] = [
  "CONTACT",
  "VEHICLE_INQUIRY",
  "GET_INFORMATION",
  "CHECK_AVAILABILITY",
  "GENERAL_LEAD",
];

export const INTERACTION_STATUSES = [
  "PENDING_APPROVAL",
  "APPROVED",
  "RUNNING",
  "MONITORING", // submitted; response timer running
  "COMPLETED", // monitoring window closed
  "SKIPPED",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
] as const;
export type InteractionStatus = (typeof INTERACTION_STATUSES)[number];
/** Statuses that count as "an active test" for duplicate prevention. */
export const ACTIVE_INTERACTION_STATUSES: readonly InteractionStatus[] = ["PENDING_APPROVAL", "APPROVED", "RUNNING", "MONITORING"];

export const RESPONSE_CLASSIFICATIONS = [
  "AUTO_CONFIRMATION",
  "AUTOMATED_FOLLOW_UP",
  "HUMAN_FOLLOW_UP",
  "MARKETING",
  "UNRELATED",
  "UNKNOWN",
] as const;
export type ResponseClassification = (typeof RESPONSE_CLASSIFICATIONS)[number];

export const SENDER_KINDS = ["HUMAN", "AUTOMATION", "UNKNOWN"] as const;
export type SenderKind = (typeof SENDER_KINDS)[number];

/** Response-time milestones tracked for every submitted interaction (seconds). */
export const MILESTONES = [
  { key: "5m", seconds: 5 * 60, label: "5 minutes" },
  { key: "15m", seconds: 15 * 60, label: "15 minutes" },
  { key: "1h", seconds: 60 * 60, label: "1 hour" },
  { key: "4h", seconds: 4 * 60 * 60, label: "4 hours" },
  { key: "24h", seconds: 24 * 60 * 60, label: "24 hours" },
  { key: "72h", seconds: 72 * 60 * 60, label: "72 hours" },
] as const;
export type MilestoneKey = (typeof MILESTONES)[number]["key"];

export const ROLE_TARGETS: Record<Product, string[]> = {
  SUMMARYBOT: ["General Manager", "BDC Director", "Internet Sales Director", "Sales Manager"],
  INVENTORY_OUTREACH: ["BDC Director", "Internet Sales Director", "General Manager"],
  SERVICE_BOT: ["Service Director", "Fixed Operations Director", "General Manager"],
  SOCIAL_AUTOMATION: ["Marketing Director", "General Manager", "Digital Marketing Manager"],
};

/** The only messages a controlled test may send. No urgency, no purchase intent, nothing to negotiate. */
export const APPROVED_MESSAGES = [
  "Is this vehicle still available?",
  "Do you have any similar models available?",
  "Can someone send me more information about this vehicle?",
  "Can someone send me more information about your current inventory?",
] as const;

export const QUEUES = [
  "prospect",
  "phone-check",
  "discovery",
  "website-scan",
  "interaction",
  "response-check",
  "inventory",
  "social",
  "signals",
  "scoring",
  "sales-intel",
  "estimate",
] as const;
export type QueueName = (typeof QUEUES)[number];

/** Pointer from a score reason / finding / brief claim to the stored record that supports it. */
export type EvidenceRef = {
  type: "observation" | "interaction" | "response" | "signal" | "evidence" | "inventory" | "social" | "transcript";
  id: string;
};
