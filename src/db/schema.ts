import { boolean, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type {
  Channel,
  Confidence,
  EvidenceRef,
  EvidenceType,
  FindingKind,
  FormType,
  InteractionStatus,
  MilestoneKey,
  PipelineStage,
  Product,
  ReceptionistStatus,
  ResponseClassification,
  Role,
  SenderKind,
  SignalType,
  SuppressionReason,
  SuppressionScope,
} from "@/domain/constants";

const id = () => uuid("id").primaryKey().defaultRandom();
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () => ts("updated_at").notNull().defaultNow();

// ---------------------------------------------------------------------------
// Shared JSON shapes
// ---------------------------------------------------------------------------

export type DetectedForm = {
  type: FormType;
  pageUrl: string;
  action: string | null;
  fields: { name: string; type: string; label: string; required: boolean }[];
  /** True when the form contains a field we will never fill (SSN, credit, trade-in, appointment...). */
  hasProhibitedFields: boolean;
  hasCaptcha: boolean;
};

export type VisitedPage = {
  url: string;
  kind: "HOMEPAGE" | "INVENTORY" | "VDP" | "CONTACT" | "SERVICE" | "SCHEDULER" | "CAREERS" | "ABOUT";
  title: string | null;
  httpStatus: number | null;
  outcome: "OK" | "BLOCKED" | "ROBOTS_DISALLOWED" | "ERROR";
  detail?: string;
};

export type ServiceDetails = {
  servicePageUrl: string | null;
  schedulerUrl: string | null;
  /** How the scheduler is reached: embedded on the dealer site, or a hand-off to a vendor domain. */
  schedulerMode: "EMBEDDED" | "EXTERNAL_LINK" | "FORM_ONLY" | "UNRECOGNISED" | "NONE";
  /** Visible form steps/fields on the first scheduler screen. Null when it could not be measured. */
  schedulerFieldCount: number | null;
  phoneOnly: boolean;
  smsOptionVisible: boolean;
  specialsPresent: boolean;
  chatOnServicePage: boolean;
  contactOptions: string[];
  frictionNotes: string[];
};

export type ScoreReason = {
  ruleId: string;
  points: number;
  label: string;
  kind: FindingKind;
  confidence: Confidence;
  evidence: EvidenceRef[];
};

export type PriorityBreakdown = {
  total: number;
  components: { key: "product" | "signals" | "confidence" | "group" | "recency"; label: string; points: number; max: number; detail: string }[];
};

export type BriefClaim = {
  text: string;
  kind: FindingKind;
  confidence: Confidence;
  evidence: EvidenceRef[];
};

export type GroupIntel = {
  rooftops: number;
  scanned: number;
  sharedTechnology: { name: string; category: string; count: number }[];
  systemicProblems: { ruleId: string; label: string; product: Product; count: number; share: number }[];
  productAverages: Record<Product, number>;
  hiringSignalCount: number;
};

// ---------------------------------------------------------------------------
// Users / auth
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").$type<Role>().notNull().default("OPERATOR"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Dealer groups & rooftops
// ---------------------------------------------------------------------------

export const dealerGroups = pgTable(
  "dealer_groups",
  {
    id: id(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    website: text("website"),
    normalizedDomain: text("normalized_domain"),
    headquarters: text("headquarters"),
    /** Operator-entered count of stores the group is known to own (may exceed rooftops in this database). */
    storeCount: integer("store_count"),
    brands: jsonb("brands").$type<string[]>().notNull().default([]),
    ownershipInformation: text("ownership_information"),
    priorityScore: integer("priority_score").notNull().default(0),
    intel: jsonb("intel").$type<GroupIntel>(),
    lastChecked: ts("last_checked"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("dealer_groups_normalized_name_uq").on(t.normalizedName)],
);

export const dealerships = pgTable(
  "dealerships",
  {
    id: id(),
    groupId: uuid("group_id").references(() => dealerGroups.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    website: text("website"),
    normalizedDomain: text("normalized_domain"),
    address: text("address"),
    normalizedAddress: text("normalized_address"),
    city: text("city"),
    state: text("state"),
    zip: text("zip"),
    phone: text("phone"),
    normalizedPhone: text("normalized_phone"),
    brands: jsonb("brands").$type<string[]>().notNull().default([]),
    inventoryCount: integer("inventory_count"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    lastChecked: ts("last_checked"),
    nextCheck: ts("next_check"),
    /** Paused rooftops are skipped by every scheduled job. */
    paused: boolean("paused").notNull().default(false),
    /** Denormalised from the suppressions table for fast filtering; suppressions is the source of truth. */
    suppressed: boolean("suppressed").notNull().default(false),
    suppressionReason: text("suppression_reason").$type<SuppressionReason>(),
    /** An operator must approve a rooftop before any controlled interaction can be created for it. */
    testingApproved: boolean("testing_approved").notNull().default(false),
    testingApprovedBy: text("testing_approved_by"),
    testingApprovedAt: ts("testing_approved_at"),
    /** Chatbot answer entered by hand, for sites the scanner cannot read. Null = rely on the scan. */
    manualChatbot: text("manual_chatbot").$type<"YES" | "NO">(),
    manualChatbotNote: text("manual_chatbot_note"),
    manualChatbotBy: text("manual_chatbot_by"),
    /** What answered the phone when an operator called: set by hand, a website cannot tell us. */
    receptionist: text("receptionist").$type<ReceptionistStatus>().notNull().default("UNKNOWN"),
    receptionistNote: text("receptionist_note"),
    receptionistCheckedAt: ts("receptionist_checked_at"),
    receptionistCheckedBy: text("receptionist_checked_by"),
    /** What was heard on the phone check, word for word as transcribed. */
    receptionistTranscript: text("receptionist_transcript"),
    /** Sentinel's size-of-operation estimate (see domain/volume): units a month, gross a month, how and how sure. */
    estUnitsLow: integer("est_units_low"),
    estUnitsHigh: integer("est_units_high"),
    estGrossLow: integer("est_gross_low"),
    estGrossHigh: integer("est_gross_high"),
    estMedianPrice: integer("est_median_price"),
    estMethod: text("est_method").$type<"TURNOVER" | "LOT_SIZE">(),
    estConfidence: text("est_confidence").$type<"LOW" | "MEDIUM" | "HIGH">(),
    estAt: ts("est_at"),
    /** Monthly gross profit range, per-vehicle gross (the dealer's take) and a salesperson's typical cut, plus the price segment. */
    estProfitLow: integer("est_profit_low"),
    estProfitHigh: integer("est_profit_high"),
    estProfitPerUnit: integer("est_profit_per_unit"),
    estCommissionPerUnit: integer("est_commission_per_unit"),
    estSegment: text("est_segment"),
    estPricesHidden: boolean("est_prices_hidden").notNull().default(false),
    pipelineStage: text("pipeline_stage").$type<PipelineStage>().notNull().default("RESEARCHING"),
    nextAction: text("next_action"),
    nextActionDue: ts("next_action_due"),
    priorityScore: integer("priority_score").notNull().default(0),
    /** Manual override set by an operator ("Change priority"). Wins over the computed score in lists. */
    priorityOverride: integer("priority_override"),
    priorityBreakdown: jsonb("priority_breakdown").$type<PriorityBreakdown>(),
    recommendedProduct: text("recommended_product").$type<Product>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("dealerships_domain_idx").on(t.normalizedDomain),
    index("dealerships_phone_idx").on(t.normalizedPhone),
    index("dealerships_group_idx").on(t.groupId),
    index("dealerships_priority_idx").on(t.priorityScore),
    index("dealerships_next_check_idx").on(t.nextCheck),
  ],
);

export const contacts = pgTable("contacts", {
  id: id(),
  dealershipId: uuid("dealership_id").notNull().references(() => dealerships.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  title: text("title"),
  email: text("email"),
  phone: text("phone"),
  /** Required: contacts are only shown when backed by a source. */
  sourceUrl: text("source_url").notNull(),
  addedBy: text("added_by").notNull(),
  createdAt: createdAt(),
});

export const notes = pgTable("notes", {
  id: id(),
  dealershipId: uuid("dealership_id").notNull().references(() => dealerships.id, { onDelete: "cascade" }),
  author: text("author").notNull(),
  body: text("body").notNull(),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Passive research
// ---------------------------------------------------------------------------

export const websiteObservations = pgTable(
  "website_observations",
  {
    id: id(),
    dealershipId: uuid("dealership_id").notNull().references(() => dealerships.id, { onDelete: "cascade" }),
    timestamp: ts("timestamp").notNull().defaultNow(),
    /** OK | BLOCKED | ROBOTS_DISALLOWED | UNREACHABLE | ERROR */
    websiteStatus: text("website_status").notNull(),
    statusDetail: text("status_detail"),
    mobileFriendly: boolean("mobile_friendly"),
    chatPresent: boolean("chat_present").notNull().default(false),
    chatVendor: text("chat_vendor"),
    /** AI | RULE_BASED | LIVE | UNKNOWN — only set when the vendor signature makes it clear. */
    chatType: text("chat_type"),
    /** Null until a controlled chat test has been logged; passive scans cannot know this. */
    chatWorking: boolean("chat_working"),
    contactRequired: boolean("contact_required"),
    chatQuality: integer("chat_quality"),
    /** GOOD | BAD | NONE — set by a controlled chat test (see domain/chat-grade). */
    chatGrade: text("chat_grade"),
    leadFormPresent: boolean("lead_form_present").notNull().default(false),
    leadFormCount: integer("lead_form_count").notNull().default(0),
    leadForms: jsonb("lead_forms").$type<DetectedForm[]>().notNull().default([]),
    inventoryPagePresent: boolean("inventory_page_present").notNull().default(false),
    inventoryCount: integer("inventory_count"),
    inventoryAlertsPresent: boolean("inventory_alerts_present"),
    servicePagePresent: boolean("service_page_present").notNull().default(false),
    serviceSchedulerPresent: boolean("service_scheduler_present").notNull().default(false),
    serviceSchedulerVendor: text("service_scheduler_vendor"),
    service: jsonb("service").$type<ServiceDetails>(),
    socialLinks: jsonb("social_links").$type<{ platform: string; url: string }[]>().notNull().default([]),
    detectedTechnology: jsonb("detected_technology").$type<{ name: string; category: string; evidence: string }[]>().notNull().default([]),
    careersUrl: text("careers_url"),
    pages: jsonb("pages").$type<VisitedPage[]>().notNull().default([]),
    notes: text("notes"),
  },
  (t) => [index("website_obs_dealer_idx").on(t.dealershipId, t.timestamp)],
);

export const inventorySnapshots = pgTable(
  "inventory_snapshots",
  {
    id: id(),
    dealershipId: uuid("dealership_id").notNull().references(() => dealerships.id, { onDelete: "cascade" }),
    capturedAt: ts("captured_at").notNull().defaultNow(),
    total: integer("total"),
    newCount: integer("new_count"),
    usedCount: integer("used_count"),
    /** How the count was derived: PAGE_COUNT_TEXT | VDP_LINK_COUNT | NONE */
    method: text("method").notNull(),
    confidence: text("confidence").$type<Confidence>().notNull(),
    makes: jsonb("makes").$type<string[]>().notNull().default([]),
    vdpUrls: jsonb("vdp_urls").$type<string[]>().notNull().default([]),
    /** Asking prices read off the inventory pages (whole dollars), and their median. Feeds the gross-sales estimate. */
    prices: jsonb("prices").$type<number[]>().notNull().default([]),
    medianPrice: integer("median_price"),
    /** The dealer hides prices ("Contact Dealer") on the listing and detail pages read. */
    pricesHidden: boolean("prices_hidden").notNull().default(false),
    sourceUrls: jsonb("source_urls").$type<string[]>().notNull().default([]),
  },
  (t) => [index("inventory_dealer_idx").on(t.dealershipId, t.capturedAt)],
);

export const socialProfiles = pgTable(
  "social_profiles",
  {
    id: id(),
    dealershipId: uuid("dealership_id").notNull().references(() => dealerships.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    url: text("url").notNull(),
    firstSeen: ts("first_seen").notNull().defaultNow(),
    lastSeen: ts("last_seen").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("social_profiles_uq").on(t.dealershipId, t.platform, t.url)],
);

export const socialObservations = pgTable("social_observations", {
  id: id(),
  dealershipId: uuid("dealership_id").notNull().references(() => dealerships.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),
  observedAt: ts("observed_at").notNull().defaultNow(),
  /** MANUAL (operator-entered) or the name of the connector that produced it. */
  source: text("source").notNull(),
  sourceUrl: text("source_url"),
  postsLast30Days: integer("posts_last_30_days"),
  inventoryPostsLast30Days: integer("inventory_posts_last_30_days"),
  customerQuestions: integer("customer_questions"),
  unansweredQuestions: integer("unanswered_questions"),
  adActivity: boolean("ad_activity"),
  confidence: text("confidence").$type<Confidence>().notNull().default("MEDIUM"),
  notes: text("notes"),
  recordedBy: text("recorded_by"),
  /** Figures a public profile page shows without signing in. Null = not shown. */
  followers: integer("followers"),
  totalPosts: integer("total_posts"),
  /** False when the platform showed a login wall instead of the profile. */
  publiclyVisible: boolean("publicly_visible"),
});

export const signals = pgTable(
  "signals",
  {
    id: id(),
    dealershipId: uuid("dealership_id").references(() => dealerships.id, { onDelete: "cascade" }),
    groupId: uuid("group_id").references(() => dealerGroups.id, { onDelete: "cascade" }),
    type: text("type").$type<SignalType>().notNull(),
    title: text("title").notNull(),
    description: text("description"),
    /** Required. A signal without a source is never stored. */
    sourceUrl: text("source_url").notNull(),
    confidence: text("confidence").$type<Confidence>().notNull(),
    kind: text("kind").$type<FindingKind>().notNull().default("OBSERVED"),
    /** CAREERS_PAGE | MANUAL | connector name */
    source: text("source").notNull(),
    /** Stable hash of (dealership, type, title) so re-scans don't duplicate signals. */
    dedupeKey: text("dedupe_key").notNull(),
    detectedAt: ts("detected_at").notNull().defaultNow(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("signals_dedupe_uq").on(t.dedupeKey), index("signals_dealer_idx").on(t.dealershipId, t.detectedAt)],
);

// ---------------------------------------------------------------------------
// Controlled interactions
// ---------------------------------------------------------------------------

export const testIdentities = pgTable("test_identities", {
  id: id(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  phone: text("phone").notNull(),
  normalizedPhone: text("normalized_phone").notNull(),
  address: text("address"),
  active: boolean("active").notNull().default(true),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
});

export const testInteractions = pgTable(
  "test_interactions",
  {
    id: id(),
    dealershipId: uuid("dealership_id").notNull().references(() => dealerships.id, { onDelete: "cascade" }),
    identityId: uuid("identity_id").references(() => testIdentities.id, { onDelete: "set null" }),
    /** FORM (automated) or CHAT (operator-run, logged manually in V1). */
    testType: text("test_type").$type<"FORM" | "CHAT">().notNull(),
    formType: text("form_type").$type<FormType>(),
    vehicleId: text("vehicle_id"),
    message: text("message"),
    status: text("status").$type<InteractionStatus>().notNull(),
    statusDetail: text("status_detail"),
    sourceUrl: text("source_url"),
    screenshotUrl: text("screenshot_url"),
    transcriptUrl: text("transcript_url"),
    requestedBy: text("requested_by").notNull(),
    approvedBy: text("approved_by"),
    approvedAt: ts("approved_at"),
    startedAt: ts("started_at"),
    submittedAt: ts("submitted_at"),
    completedAt: ts("completed_at"),
    firstResponseSeconds: integer("first_response_seconds"),
    /** Per-milestone result once the milestone has elapsed: true = a response had arrived by then. */
    milestones: jsonb("milestones").$type<Partial<Record<MilestoneKey, boolean>>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("interactions_dealer_idx").on(t.dealershipId, t.createdAt), index("interactions_status_idx").on(t.status)],
);

export const responses = pgTable(
  "responses",
  {
    id: id(),
    interactionId: uuid("interaction_id").notNull().references(() => testInteractions.id, { onDelete: "cascade" }),
    channel: text("channel").$type<Channel>().notNull(),
    receivedAt: ts("received_at").notNull(),
    responseSeconds: integer("response_seconds").notNull(),
    sender: text("sender"),
    classification: text("classification").$type<ResponseClassification>().notNull().default("UNKNOWN"),
    humanOrAutomation: text("human_or_automation").$type<SenderKind>().notNull().default("UNKNOWN"),
    /** RULE | AI | MANUAL — who produced the classification above. */
    classifiedBy: text("classified_by").notNull().default("RULE"),
    message: text("message"),
    personalizationScore: integer("personalization_score"),
    questionAnswered: boolean("question_answered"),
    vehicleReferenced: boolean("vehicle_referenced"),
    callToAction: text("call_to_action"),
    qualityScore: integer("quality_score"),
    /** WEBHOOK | MANUAL */
    ingestedVia: text("ingested_via").notNull(),
    /** Provider message id; makes webhook redelivery idempotent. */
    externalId: text("external_id"),
    createdAt: createdAt(),
  },
  (t) => [index("responses_interaction_idx").on(t.interactionId, t.receivedAt), uniqueIndex("responses_external_uq").on(t.externalId)],
);

/** Inbound messages that arrived for a test identity but could not be tied to exactly one open interaction. */
export const unmatchedInbound = pgTable("unmatched_inbound", {
  id: id(),
  channel: text("channel").$type<Channel>().notNull(),
  receivedAt: ts("received_at").notNull(),
  sender: text("sender"),
  recipient: text("recipient"),
  message: text("message"),
  reason: text("reason").notNull(),
  externalId: text("external_id"),
  resolvedInteractionId: uuid("resolved_interaction_id"),
  createdAt: createdAt(),
});

export const transcriptMessages = pgTable(
  "transcript_messages",
  {
    id: id(),
    interactionId: uuid("interaction_id").notNull().references(() => testInteractions.id, { onDelete: "cascade" }),
    dealershipId: uuid("dealership_id").notNull().references(() => dealerships.id, { onDelete: "cascade" }),
    timestamp: ts("timestamp").notNull(),
    /** RESEARCHER | DEALERSHIP | SYSTEM */
    speaker: text("speaker").notNull(),
    channel: text("channel").$type<Channel>().notNull(),
    message: text("message").notNull(),
  },
  (t) => [index("transcript_interaction_idx").on(t.interactionId, t.timestamp)],
);

export const evidence = pgTable(
  "evidence",
  {
    id: id(),
    dealershipId: uuid("dealership_id").notNull().references(() => dealerships.id, { onDelete: "cascade" }),
    interactionId: uuid("interaction_id").references(() => testInteractions.id, { onDelete: "set null" }),
    observationId: uuid("observation_id").references(() => websiteObservations.id, { onDelete: "set null" }),
    type: text("type").$type<EvidenceType>().notNull(),
    /** Object key inside the evidence bucket. Binary data never lives in Postgres. */
    storageKey: text("storage_key").notNull(),
    storageUrl: text("storage_url").notNull(),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    sourceUrl: text("source_url"),
    capturedAt: ts("captured_at").notNull().defaultNow(),
  },
  (t) => [index("evidence_dealer_idx").on(t.dealershipId, t.capturedAt)],
);

// ---------------------------------------------------------------------------
// Scoring & sales intelligence
// ---------------------------------------------------------------------------

export const scores = pgTable(
  "scores",
  {
    id: id(),
    dealershipId: uuid("dealership_id").notNull().references(() => dealerships.id, { onDelete: "cascade" }),
    product: text("product").$type<Product>().notNull(),
    score: integer("score").notNull(),
    reasons: jsonb("reasons").$type<ScoreReason[]>().notNull().default([]),
    computedAt: ts("computed_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("scores_dealer_product_uq").on(t.dealershipId, t.product)],
);

/** Appended only when a score actually changes, so the evidence timeline can show movements. */
export const scoreHistory = pgTable(
  "score_history",
  {
    id: id(),
    dealershipId: uuid("dealership_id").notNull().references(() => dealerships.id, { onDelete: "cascade" }),
    /** A product, or "PRIORITY" for the overall score. */
    subject: text("subject").notNull(),
    previous: integer("previous"),
    score: integer("score").notNull(),
    changedAt: ts("changed_at").notNull().defaultNow(),
  },
  (t) => [index("score_history_dealer_idx").on(t.dealershipId, t.changedAt)],
);

export const findings = pgTable(
  "findings",
  {
    id: id(),
    dealershipId: uuid("dealership_id").notNull().references(() => dealerships.id, { onDelete: "cascade" }),
    kind: text("kind").$type<FindingKind>().notNull(),
    confidence: text("confidence").$type<Confidence>().notNull(),
    product: text("product").$type<Product>(),
    key: text("key").notNull(),
    statement: text("statement").notNull(),
    evidence: jsonb("evidence").$type<EvidenceRef[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [index("findings_dealer_idx").on(t.dealershipId)],
);

export const salesBriefs = pgTable(
  "sales_briefs",
  {
    id: id(),
    dealershipId: uuid("dealership_id").notNull().references(() => dealerships.id, { onDelete: "cascade" }),
    generatedAt: ts("generated_at").notNull().defaultNow(),
    priorityScore: integer("priority_score").notNull(),
    recommendedProduct: text("recommended_product").$type<Product>(),
    secondaryProduct: text("secondary_product").$type<Product>(),
    mainProblem: text("main_problem"),
    claims: jsonb("claims").$type<BriefClaim[]>().notNull().default([]),
    salesAngle: text("sales_angle"),
    /** AI | TEMPLATE — a template angle is assembled from fixed product wording plus stored facts. */
    angleSource: text("angle_source").notNull(),
    recommendedRoles: jsonb("recommended_roles").$type<string[]>().notNull().default([]),
    nextAction: text("next_action"),
    model: text("model"),
    /** Hash of the evidence the brief was built from; unchanged evidence does not regenerate. */
    inputHash: text("input_hash").notNull(),
    coldCallOpener: text("cold_call_opener"),
    discoveryQuestion: text("discovery_question"),
  },
  (t) => [index("briefs_dealer_idx").on(t.dealershipId, t.generatedAt)],
);

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

export const suppressions = pgTable(
  "suppressions",
  {
    id: id(),
    scope: text("scope").$type<SuppressionScope>().notNull(),
    dealershipId: uuid("dealership_id").references(() => dealerships.id, { onDelete: "cascade" }),
    groupId: uuid("group_id").references(() => dealerGroups.id, { onDelete: "cascade" }),
    domain: text("domain"),
    phone: text("phone"),
    reason: text("reason").$type<SuppressionReason>().notNull(),
    note: text("note"),
    /** GROUP scope only: when true every rooftop in the group is suppressed too. */
    includeRooftops: boolean("include_rooftops").notNull().default(true),
    active: boolean("active").notNull().default(true),
    expiresAt: ts("expires_at"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    liftedBy: text("lifted_by"),
    liftedAt: ts("lifted_at"),
  },
  (t) => [index("suppressions_active_idx").on(t.active, t.scope)],
);

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export const jobRuns = pgTable(
  "job_runs",
  {
    id: id(),
    jobId: text("job_id").notNull(),
    queue: text("queue").notNull(),
    worker: text("worker").notNull(),
    dealershipId: uuid("dealership_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    startedAt: ts("started_at").notNull().defaultNow(),
    completedAt: ts("completed_at"),
    durationMs: integer("duration_ms"),
    /** RUNNING | COMPLETED | FAILED | SKIPPED */
    status: text("status").notNull(),
    result: text("result"),
    error: text("error"),
    retryCount: integer("retry_count").notNull().default(0),
    /** AI usage during this job: requests, tokens and the estimated spend in US dollars. */
    aiRequests: integer("ai_requests").notNull().default(0),
    aiInputTokens: integer("ai_input_tokens").notNull().default(0),
    aiOutputTokens: integer("ai_output_tokens").notNull().default(0),
    aiCostUsd: doublePrecision("ai_cost_usd").notNull().default(0),
  },
  (t) => [index("job_runs_started_idx").on(t.startedAt), index("job_runs_status_idx").on(t.status)],
);

/** One line in an agent's live activity feed. Written by the workers as they go. */
/** Dealership candidates found by prospecting, with the screening verdict. Only ADMITTED ones become dealerships. */
export const prospects = pgTable(
  "prospects",
  {
    id: id(),
    /** OSM for OpenStreetMap; MANUAL for a candidate typed in. */
    source: text("source").notNull(),
    externalId: text("external_id"),
    name: text("name").notNull(),
    website: text("website"),
    normalizedDomain: text("normalized_domain"),
    phone: text("phone"),
    city: text("city"),
    state: text("state"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    distanceKm: doublePrecision("distance_km"),
    /** NEW | SCREENING | ADMITTED | REJECTED */
    status: text("status").notNull().default("NEW"),
    reason: text("reason"),
    screenedAt: ts("screened_at"),
    dealershipId: uuid("dealership_id").references(() => dealerships.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("prospects_domain_uq").on(t.normalizedDomain), index("prospects_status_idx").on(t.status, t.distanceKm)],
);

export const agentEvents = pgTable(
  "agent_events",
  {
    id: id(),
    agent: text("agent").notNull(),
    jobRunId: uuid("job_run_id"),
    dealershipId: uuid("dealership_id").references(() => dealerships.id, { onDelete: "cascade" }),
    interactionId: uuid("interaction_id").references(() => testInteractions.id, { onDelete: "cascade" }),
    evidenceId: uuid("evidence_id"),
    at: ts("at").notNull().defaultNow(),
    step: text("step").notNull(),
    detail: text("detail"),
    /** INFO | DONE | ERROR | BLOCKED */
    status: text("status").notNull().default("INFO"),
    /** task.created | task.started | task.step.completed | finding.created | evidence.saved | response.received | task.failed | task.completed | task.blocked | task.scheduled */
    kind: text("kind").notNull().default("task.step.completed"),
  },
  (t) => [index("agent_events_agent_idx").on(t.agent, t.at), index("agent_events_job_idx").on(t.jobRunId), index("agent_events_dealer_idx").on(t.dealershipId, t.at)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id"),
    timestamp: ts("timestamp").notNull().defaultNow(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index("audit_ts_idx").on(t.timestamp), index("audit_entity_idx").on(t.entity, t.entityId)],
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: updatedAt(),
  updatedBy: text("updated_by"),
});

export const aiCache = pgTable("ai_cache", {
  hash: text("hash").primaryKey(),
  task: text("task").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  result: jsonb("result").$type<unknown>().notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  createdAt: createdAt(),
});

export type Dealership = typeof dealerships.$inferSelect;
export type DealerGroup = typeof dealerGroups.$inferSelect;
export type WebsiteObservation = typeof websiteObservations.$inferSelect;
export type InventorySnapshot = typeof inventorySnapshots.$inferSelect;
export type Signal = typeof signals.$inferSelect;
export type SocialObservation = typeof socialObservations.$inferSelect;
export type TestIdentity = typeof testIdentities.$inferSelect;
export type TestInteraction = typeof testInteractions.$inferSelect;
export type ResponseRow = typeof responses.$inferSelect;
export type Suppression = typeof suppressions.$inferSelect;
export type Evidence = typeof evidence.$inferSelect;
export type User = typeof users.$inferSelect;
export type ScoreRow = typeof scores.$inferSelect;
export type SalesBrief = typeof salesBriefs.$inferSelect;
