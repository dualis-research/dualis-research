CREATE TABLE "gold"."thierry_inputs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"scope" text NOT NULL,
	"symbol" text,
	"company" text,
	"on_watchlist" boolean DEFAULT false NOT NULL,
	"text" text NOT NULL,
	"file_name" text,
	"said_at" timestamp with time zone NOT NULL,
	"pushed_at" timestamp with time zone NOT NULL,
	"rebuilt_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "silver"."thierry_inputs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"scope" text NOT NULL,
	"symbol" text,
	"text" text NOT NULL,
	"file_name" text,
	"said_at" timestamp with time zone NOT NULL,
	"pushed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text NOT NULL,
	"bronze_ids" uuid[] NOT NULL
);
--> statement-breakpoint
CREATE INDEX "gold_thierry_inputs_symbol" ON "gold"."thierry_inputs" USING btree ("symbol","said_at");--> statement-breakpoint
CREATE INDEX "gold_thierry_inputs_said" ON "gold"."thierry_inputs" USING btree ("said_at");--> statement-breakpoint
CREATE INDEX "silver_thierry_inputs_said" ON "silver"."thierry_inputs" USING btree ("said_at");