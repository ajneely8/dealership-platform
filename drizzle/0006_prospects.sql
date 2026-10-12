CREATE TABLE "prospects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_id" text,
	"name" text NOT NULL,
	"website" text,
	"normalized_domain" text,
	"phone" text,
	"city" text,
	"state" text,
	"latitude" double precision,
	"longitude" double precision,
	"distance_km" double precision,
	"status" text DEFAULT 'NEW' NOT NULL,
	"reason" text,
	"screened_at" timestamp with time zone,
	"dealership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prospects_domain_uq" ON "prospects" USING btree ("normalized_domain");--> statement-breakpoint
CREATE INDEX "prospects_status_idx" ON "prospects" USING btree ("status","distance_km");