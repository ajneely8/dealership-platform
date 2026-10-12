CREATE TABLE "ai_cache" (
	"hash" text PRIMARY KEY NOT NULL,
	"task" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"result" jsonb NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealership_id" uuid NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"email" text,
	"phone" text,
	"source_url" text NOT NULL,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dealer_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"website" text,
	"normalized_domain" text,
	"headquarters" text,
	"store_count" integer,
	"brands" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ownership_information" text,
	"priority_score" integer DEFAULT 0 NOT NULL,
	"intel" jsonb,
	"last_checked" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dealerships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"website" text,
	"normalized_domain" text,
	"address" text,
	"normalized_address" text,
	"city" text,
	"state" text,
	"zip" text,
	"phone" text,
	"normalized_phone" text,
	"brands" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inventory_count" integer,
	"latitude" double precision,
	"longitude" double precision,
	"last_checked" timestamp with time zone,
	"next_check" timestamp with time zone,
	"paused" boolean DEFAULT false NOT NULL,
	"suppressed" boolean DEFAULT false NOT NULL,
	"suppression_reason" text,
	"testing_approved" boolean DEFAULT false NOT NULL,
	"testing_approved_by" text,
	"testing_approved_at" timestamp with time zone,
	"pipeline_stage" text DEFAULT 'RESEARCHING' NOT NULL,
	"next_action" text,
	"next_action_due" timestamp with time zone,
	"priority_score" integer DEFAULT 0 NOT NULL,
	"priority_override" integer,
	"priority_breakdown" jsonb,
	"recommended_product" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealership_id" uuid NOT NULL,
	"interaction_id" uuid,
	"observation_id" uuid,
	"type" text NOT NULL,
	"storage_key" text NOT NULL,
	"storage_url" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"source_url" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealership_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"confidence" text NOT NULL,
	"product" text,
	"key" text NOT NULL,
	"statement" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealership_id" uuid NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total" integer,
	"new_count" integer,
	"used_count" integer,
	"method" text NOT NULL,
	"confidence" text NOT NULL,
	"makes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"vdp_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_urls" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" text NOT NULL,
	"queue" text NOT NULL,
	"worker" text NOT NULL,
	"dealership_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"duration_ms" integer,
	"status" text NOT NULL,
	"result" text,
	"error" text,
	"retry_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealership_id" uuid NOT NULL,
	"author" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interaction_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"response_seconds" integer NOT NULL,
	"sender" text,
	"classification" text DEFAULT 'UNKNOWN' NOT NULL,
	"human_or_automation" text DEFAULT 'UNKNOWN' NOT NULL,
	"classified_by" text DEFAULT 'RULE' NOT NULL,
	"message" text,
	"personalization_score" integer,
	"question_answered" boolean,
	"vehicle_referenced" boolean,
	"call_to_action" text,
	"quality_score" integer,
	"ingested_via" text NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealership_id" uuid NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"priority_score" integer NOT NULL,
	"recommended_product" text,
	"secondary_product" text,
	"main_problem" text,
	"claims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sales_angle" text,
	"angle_source" text NOT NULL,
	"recommended_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"next_action" text,
	"model" text,
	"input_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "score_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealership_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"previous" integer,
	"score" integer NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealership_id" uuid NOT NULL,
	"product" text NOT NULL,
	"score" integer NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealership_id" uuid,
	"group_id" uuid,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"source_url" text NOT NULL,
	"confidence" text NOT NULL,
	"kind" text DEFAULT 'OBSERVED' NOT NULL,
	"source" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealership_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"source_url" text,
	"posts_last_30_days" integer,
	"inventory_posts_last_30_days" integer,
	"customer_questions" integer,
	"unanswered_questions" integer,
	"ad_activity" boolean,
	"confidence" text DEFAULT 'MEDIUM' NOT NULL,
	"notes" text,
	"recorded_by" text
);
--> statement-breakpoint
CREATE TABLE "social_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealership_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"url" text NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"dealership_id" uuid,
	"group_id" uuid,
	"domain" text,
	"phone" text,
	"reason" text NOT NULL,
	"note" text,
	"include_rooftops" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_by" text,
	"lifted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "test_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"normalized_phone" text NOT NULL,
	"address" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_identities_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "test_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealership_id" uuid NOT NULL,
	"identity_id" uuid,
	"test_type" text NOT NULL,
	"form_type" text,
	"vehicle_id" text,
	"message" text,
	"status" text NOT NULL,
	"status_detail" text,
	"source_url" text,
	"screenshot_url" text,
	"transcript_url" text,
	"requested_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"first_response_seconds" integer,
	"milestones" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcript_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interaction_id" uuid NOT NULL,
	"dealership_id" uuid NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"speaker" text NOT NULL,
	"channel" text NOT NULL,
	"message" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unmatched_inbound" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"sender" text,
	"recipient" text,
	"message" text,
	"reason" text NOT NULL,
	"external_id" text,
	"resolved_interaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'OPERATOR' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "website_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealership_id" uuid NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"website_status" text NOT NULL,
	"status_detail" text,
	"mobile_friendly" boolean,
	"chat_present" boolean DEFAULT false NOT NULL,
	"chat_vendor" text,
	"chat_type" text,
	"chat_working" boolean,
	"contact_required" boolean,
	"chat_quality" integer,
	"lead_form_present" boolean DEFAULT false NOT NULL,
	"lead_form_count" integer DEFAULT 0 NOT NULL,
	"lead_forms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inventory_page_present" boolean DEFAULT false NOT NULL,
	"inventory_count" integer,
	"inventory_alerts_present" boolean,
	"service_page_present" boolean DEFAULT false NOT NULL,
	"service_scheduler_present" boolean DEFAULT false NOT NULL,
	"service_scheduler_vendor" text,
	"service" jsonb,
	"social_links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detected_technology" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"careers_url" text,
	"pages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dealerships" ADD CONSTRAINT "dealerships_group_id_dealer_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."dealer_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_interaction_id_test_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."test_interactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_observation_id_website_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."website_observations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_snapshots" ADD CONSTRAINT "inventory_snapshots_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_interaction_id_test_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."test_interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_briefs" ADD CONSTRAINT "sales_briefs_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_history" ADD CONSTRAINT "score_history_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_group_id_dealer_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."dealer_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_observations" ADD CONSTRAINT "social_observations_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_profiles" ADD CONSTRAINT "social_profiles_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_group_id_dealer_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."dealer_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_interactions" ADD CONSTRAINT "test_interactions_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_interactions" ADD CONSTRAINT "test_interactions_identity_id_test_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."test_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_messages" ADD CONSTRAINT "transcript_messages_interaction_id_test_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."test_interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_messages" ADD CONSTRAINT "transcript_messages_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_observations" ADD CONSTRAINT "website_observations_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_ts_idx" ON "audit_logs" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_logs" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dealer_groups_normalized_name_uq" ON "dealer_groups" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "dealerships_domain_idx" ON "dealerships" USING btree ("normalized_domain");--> statement-breakpoint
CREATE INDEX "dealerships_phone_idx" ON "dealerships" USING btree ("normalized_phone");--> statement-breakpoint
CREATE INDEX "dealerships_group_idx" ON "dealerships" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "dealerships_priority_idx" ON "dealerships" USING btree ("priority_score");--> statement-breakpoint
CREATE INDEX "dealerships_next_check_idx" ON "dealerships" USING btree ("next_check");--> statement-breakpoint
CREATE INDEX "evidence_dealer_idx" ON "evidence" USING btree ("dealership_id","captured_at");--> statement-breakpoint
CREATE INDEX "findings_dealer_idx" ON "findings" USING btree ("dealership_id");--> statement-breakpoint
CREATE INDEX "inventory_dealer_idx" ON "inventory_snapshots" USING btree ("dealership_id","captured_at");--> statement-breakpoint
CREATE INDEX "job_runs_started_idx" ON "job_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "job_runs_status_idx" ON "job_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "responses_interaction_idx" ON "responses" USING btree ("interaction_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "responses_external_uq" ON "responses" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "briefs_dealer_idx" ON "sales_briefs" USING btree ("dealership_id","generated_at");--> statement-breakpoint
CREATE INDEX "score_history_dealer_idx" ON "score_history" USING btree ("dealership_id","changed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scores_dealer_product_uq" ON "scores" USING btree ("dealership_id","product");--> statement-breakpoint
CREATE UNIQUE INDEX "signals_dedupe_uq" ON "signals" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "signals_dealer_idx" ON "signals" USING btree ("dealership_id","detected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "social_profiles_uq" ON "social_profiles" USING btree ("dealership_id","platform","url");--> statement-breakpoint
CREATE INDEX "suppressions_active_idx" ON "suppressions" USING btree ("active","scope");--> statement-breakpoint
CREATE INDEX "interactions_dealer_idx" ON "test_interactions" USING btree ("dealership_id","created_at");--> statement-breakpoint
CREATE INDEX "interactions_status_idx" ON "test_interactions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "transcript_interaction_idx" ON "transcript_messages" USING btree ("interaction_id","timestamp");--> statement-breakpoint
CREATE INDEX "website_obs_dealer_idx" ON "website_observations" USING btree ("dealership_id","timestamp");