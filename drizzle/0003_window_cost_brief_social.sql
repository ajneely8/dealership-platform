ALTER TABLE "job_runs" ADD COLUMN "ai_requests" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "ai_input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "ai_output_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "ai_cost_usd" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_briefs" ADD COLUMN "cold_call_opener" text;--> statement-breakpoint
ALTER TABLE "sales_briefs" ADD COLUMN "discovery_question" text;--> statement-breakpoint
ALTER TABLE "social_observations" ADD COLUMN "followers" integer;--> statement-breakpoint
ALTER TABLE "social_observations" ADD COLUMN "total_posts" integer;--> statement-breakpoint
ALTER TABLE "social_observations" ADD COLUMN "publicly_visible" boolean;