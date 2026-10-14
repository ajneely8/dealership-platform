ALTER TABLE "dealerships" ADD COLUMN "ownership" text DEFAULT 'UNVERIFIED' NOT NULL;--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "ownership_quote" text;--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "ownership_reason" text;--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "ownership_source_url" text;--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "ownership_method" text;--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "ownership_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "ownership_verified_by" text;--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "ownership_checked_at" timestamp with time zone;