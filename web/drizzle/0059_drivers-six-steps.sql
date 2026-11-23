-- Both gold tables are rebuilt every run (market-reaction, kpi-drivers): empty them so the NOT NULL columns can land.
DELETE FROM "gold"."kpi_drivers";--> statement-breakpoint
DELETE FROM "gold"."price_moves";--> statement-breakpoint
CREATE TABLE "gold"."driver_events" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"kind" text NOT NULL,
	"source_id" text NOT NULL,
	"day" text NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"stock" double precision,
	"bench_return" double precision,
	"beta" double precision,
	"reaction" double precision,
	"z" double precision,
	"bench" text NOT NULL,
	"move_id" text,
	"rebuilt_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gold"."kpi_drivers" ADD COLUMN "expected" text NOT NULL;--> statement-breakpoint
ALTER TABLE "gold"."kpi_drivers" ADD COLUMN "measure" jsonb;--> statement-breakpoint
ALTER TABLE "gold"."kpi_drivers" ADD COLUMN "periods" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "gold"."price_moves" ADD COLUMN "last_start" text NOT NULL;--> statement-breakpoint
ALTER TABLE "gold"."price_moves" ADD COLUMN "bench" text NOT NULL;--> statement-breakpoint
CREATE INDEX "gold_driver_events_symbol" ON "gold"."driver_events" USING btree ("symbol","day");