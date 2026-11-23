CREATE TABLE "silver"."daily_email_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" text NOT NULL,
	"mode" text NOT NULL,
	"roles" text[] NOT NULL,
	"recipients" text[] NOT NULL,
	"subject" text NOT NULL,
	"items" text[] NOT NULL,
	"status" text NOT NULL,
	"response" jsonb NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "silver"."daily_item_verdicts" (
	"symbol" text NOT NULL,
	"kind" text NOT NULL,
	"item_id" text NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"publisher" text,
	"at" timestamp with time zone,
	"material" boolean NOT NULL,
	"summary" text,
	"why" text,
	"model" text NOT NULL,
	"bronze_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_item_verdicts_symbol_kind_item_id_pk" PRIMARY KEY("symbol","kind","item_id")
);
--> statement-breakpoint
CREATE TABLE "gold"."daily_digests" (
	"day" text PRIMARY KEY NOT NULL,
	"items" jsonb NOT NULL,
	"subject" text,
	"text" text,
	"html" text,
	"send_status" text,
	"sent_at" timestamp with time zone,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "daily_item_verdicts_created" ON "silver"."daily_item_verdicts" USING btree ("created_at");