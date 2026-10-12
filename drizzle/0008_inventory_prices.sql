ALTER TABLE "inventory_snapshots" ADD COLUMN "prices" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_snapshots" ADD COLUMN "median_price" integer;