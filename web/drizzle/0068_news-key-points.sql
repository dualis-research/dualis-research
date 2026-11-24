CREATE TABLE "silver"."daily_item_texts" (
	"kind" text NOT NULL,
	"item_id" text NOT NULL,
	"status" text NOT NULL,
	"text" text,
	"url" text,
	"method" text,
	"why" text,
	"attempts" integer NOT NULL,
	"bronze_ids" uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_item_texts_kind_item_id_pk" PRIMARY KEY("kind","item_id")
);
--> statement-breakpoint
ALTER TABLE "silver"."daily_item_verdicts" ADD COLUMN "key_points" text[];