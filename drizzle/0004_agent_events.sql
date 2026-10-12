CREATE TABLE "agent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent" text NOT NULL,
	"job_run_id" uuid,
	"dealership_id" uuid,
	"interaction_id" uuid,
	"evidence_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"step" text NOT NULL,
	"detail" text,
	"status" text DEFAULT 'INFO' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_interaction_id_test_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."test_interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_events_agent_idx" ON "agent_events" USING btree ("agent","at");--> statement-breakpoint
CREATE INDEX "agent_events_job_idx" ON "agent_events" USING btree ("job_run_id");--> statement-breakpoint
CREATE INDEX "agent_events_dealer_idx" ON "agent_events" USING btree ("dealership_id","at");