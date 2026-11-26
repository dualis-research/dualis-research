CREATE TABLE "gold"."stock_story" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"start_day" text NOT NULL,
	"end_day" text NOT NULL,
	"cause" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"return_pct" double precision,
	"bench_return" double precision,
	"bench" text NOT NULL,
	"move_ids" jsonb NOT NULL,
	"event_ids" jsonb NOT NULL,
	"rebuilt_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "gold_stock_story_symbol" ON "gold"."stock_story" USING btree ("symbol","start_day");