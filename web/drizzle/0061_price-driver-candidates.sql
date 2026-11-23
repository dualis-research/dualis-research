ALTER TABLE "gold"."kpi_drivers" ADD COLUMN "kind" text DEFAULT 'kpi' NOT NULL;--> statement-breakpoint
ALTER TABLE "gold"."kpi_drivers" ADD COLUMN "found_in" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "gold"."kpi_drivers" ADD COLUMN "tests" jsonb;