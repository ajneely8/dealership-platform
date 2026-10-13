CREATE TABLE "buying_intent_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealership_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"band" text NOT NULL,
	"readiness" text NOT NULL,
	"confidence" text NOT NULL,
	"signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rule_version" integer DEFAULT 1 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buying_intent_scores_dealership_id_unique" UNIQUE("dealership_id")
);
--> statement-breakpoint
ALTER TABLE "buying_intent_scores" ADD CONSTRAINT "buying_intent_scores_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "buying_intent" integer;--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "buyer_readiness" text;--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "intent_confidence" text;--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "intent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales_touches" ADD COLUMN "mrr" integer;