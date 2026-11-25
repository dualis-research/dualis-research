CREATE TABLE "silver"."translations" (
	"kind" text NOT NULL,
	"item_id" text NOT NULL,
	"original" text NOT NULL,
	"english" text NOT NULL,
	"model" text,
	"bronze_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "translations_kind_item_id_pk" PRIMARY KEY("kind","item_id")
);
--> statement-breakpoint
ALTER TABLE "gold"."filings" ADD COLUMN "title_original" text;--> statement-breakpoint
ALTER TABLE "gold"."news_items" ADD COLUMN "title_original" text;