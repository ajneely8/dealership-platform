import type { Product } from "../constants";

/**
 * Every scoring rule, its product and its default weight. Weights and thresholds are
 * editable in Settings; the rule logic itself lives in rules.ts and is deterministic.
 */
export type RuleMeta = { id: string; product: Product; label: string; defaultPoints: number; needs: "PASSIVE" | "INTERACTION" | "SIGNAL" | "SOCIAL" };

export const RULES: readonly RuleMeta[] = [
  // SummaryBot — mostly needs a controlled interaction to have run.
  { id: "sb.no_sms", product: "SUMMARYBOT", label: "No SMS response within 60 minutes", defaultPoints: 25, needs: "INTERACTION" },
  { id: "sb.slow_response", product: "SUMMARYBOT", label: "First response took over 15 minutes", defaultPoints: 20, needs: "INTERACTION" },
  { id: "sb.no_response_1h", product: "SUMMARYBOT", label: "No response of any kind within 1 hour", defaultPoints: 30, needs: "INTERACTION" },
  { id: "sb.generic_email", product: "SUMMARYBOT", label: "Generic automated email", defaultPoints: 10, needs: "INTERACTION" },
  { id: "sb.chat_failed", product: "SUMMARYBOT", label: "Chatbot is broken or could not answer a basic question", defaultPoints: 20, needs: "INTERACTION" },
  { id: "sb.no_follow_up", product: "SUMMARYBOT", label: "No continued follow-up after the first response", defaultPoints: 15, needs: "INTERACTION" },
  { id: "sb.no_chatbot", product: "SUMMARYBOT", label: "No chatbot on the website", defaultPoints: 25, needs: "PASSIVE" },
  { id: "sb.no_lead_form", product: "SUMMARYBOT", label: "No lead form on the website", defaultPoints: 15, needs: "PASSIVE" },
  { id: "sb.growth_hiring", product: "SUMMARYBOT", label: "Hiring for sales, intake or growth roles", defaultPoints: 15, needs: "SIGNAL" },

  // Inventory Outreach
  { id: "io.large_inventory", product: "INVENTORY_OUTREACH", label: "Large inventory", defaultPoints: 15, needs: "PASSIVE" },
  { id: "io.high_movement", product: "INVENTORY_OUTREACH", label: "High inventory movement", defaultPoints: 15, needs: "PASSIVE" },
  { id: "io.no_alerts", product: "INVENTORY_OUTREACH", label: "No inventory alert sign-up found", defaultPoints: 20, needs: "PASSIVE" },
  { id: "io.bdc_hiring", product: "INVENTORY_OUTREACH", label: "Hiring BDC staff", defaultPoints: 20, needs: "SIGNAL" },
  { id: "io.internet_sales_hiring", product: "INVENTORY_OUTREACH", label: "Hiring internet sales staff", defaultPoints: 15, needs: "SIGNAL" },
  { id: "io.crm_hiring", product: "INVENTORY_OUTREACH", label: "Hiring CRM / sales development staff", defaultPoints: 10, needs: "SIGNAL" },
  { id: "io.inventory_ads", product: "INVENTORY_OUTREACH", label: "Heavy inventory advertising", defaultPoints: 15, needs: "SIGNAL" },

  // Service Bot
  { id: "sv.poor_scheduler", product: "SERVICE_BOT", label: "Service scheduling friction", defaultPoints: 20, needs: "PASSIVE" },
  { id: "sv.no_service_chat", product: "SERVICE_BOT", label: "No chat on the service page", defaultPoints: 15, needs: "PASSIVE" },
  { id: "sv.no_sms", product: "SERVICE_BOT", label: "No visible SMS option for service", defaultPoints: 15, needs: "PASSIVE" },
  { id: "sv.complaints", product: "SERVICE_BOT", label: "Service scheduling complaints", defaultPoints: 20, needs: "SIGNAL" },
  { id: "sv.service_hiring", product: "SERVICE_BOT", label: "Hiring service staff", defaultPoints: 15, needs: "SIGNAL" },
  { id: "sv.large_service", product: "SERVICE_BOT", label: "Large service operation", defaultPoints: 15, needs: "SIGNAL" },

  // Social Automation
  { id: "so.high_activity", product: "SOCIAL_AUTOMATION", label: "High social posting activity", defaultPoints: 15, needs: "SOCIAL" },
  { id: "so.inventory_promoted", product: "SOCIAL_AUTOMATION", label: "Inventory heavily promoted on social", defaultPoints: 15, needs: "SOCIAL" },
  { id: "so.customer_questions", product: "SOCIAL_AUTOMATION", label: "Customers asking questions on social", defaultPoints: 20, needs: "SOCIAL" },
  { id: "so.unanswered", product: "SOCIAL_AUTOMATION", label: "Social questions apparently unanswered", defaultPoints: 25, needs: "SOCIAL" },
  { id: "so.marketing_hiring", product: "SOCIAL_AUTOMATION", label: "Hiring marketing / social staff", defaultPoints: 10, needs: "SIGNAL" },
  { id: "so.ads", product: "SOCIAL_AUTOMATION", label: "Heavy social advertising", defaultPoints: 15, needs: "SOCIAL" },
];

export const DEFAULT_WEIGHTS: Record<string, number> = Object.fromEntries(RULES.map((r) => [r.id, r.defaultPoints]));

export type Thresholds = {
  /** Vehicles in stock at or above which inventory counts as "large". */
  largeInventory: number;
  /** Percent of listings changed between two snapshots that counts as high movement. */
  inventoryMovementPct: number;
  /** First-screen scheduler fields at or above which the scheduler counts as high-friction. */
  schedulerFieldCount: number;
  socialPostsPerMonth: number;
  socialInventoryPostsPerMonth: number;
  socialCustomerQuestions: number;
  socialUnansweredQuestions: number;
  /** Signals older than this are ignored by scoring. */
  signalRecencyDays: number;
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  largeInventory: 300,
  inventoryMovementPct: 10,
  schedulerFieldCount: 8,
  socialPostsPerMonth: 20,
  socialInventoryPostsPerMonth: 8,
  socialCustomerQuestions: 5,
  socialUnansweredQuestions: 3,
  signalRecencyDays: 60,
};

export type ScoringConfig = { weights: Record<string, number>; thresholds: Thresholds };
export const DEFAULT_SCORING_CONFIG: ScoringConfig = { weights: DEFAULT_WEIGHTS, thresholds: DEFAULT_THRESHOLDS };
