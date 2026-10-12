ALTER TABLE "dealerships" ADD COLUMN "est_units_low" integer;--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "est_units_high" integer;--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "est_gross_low" integer;--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "est_gross_high" integer;--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "est_median_price" integer;--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "est_method" text;--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "est_confidence" text;--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "est_at" timestamp with time zone;