ALTER TABLE "dealerships" ADD COLUMN "receptionist" text DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "receptionist_note" text;--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "receptionist_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "receptionist_checked_by" text;