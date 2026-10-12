CREATE TABLE "sales_touches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealership_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"note" text,
	"by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales_touches" ADD CONSTRAINT "sales_touches_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_touches_dealer_idx" ON "sales_touches" USING btree ("dealership_id","created_at");--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "sales_status" text;--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "last_touch_at" timestamp with time zone;