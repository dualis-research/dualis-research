CREATE TABLE "silver"."urgent_alert_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" text NOT NULL,
	"kind" text NOT NULL,
	"item_id" text NOT NULL,
	"mode" text NOT NULL,
	"roles" text[] NOT NULL,
	"recipients" text[] NOT NULL,
	"subject" text NOT NULL,
	"status" text NOT NULL,
	"response" jsonb NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "silver"."daily_item_verdicts" ADD COLUMN "level" text;--> statement-breakpoint
CREATE UNIQUE INDEX "urgent_alert_sends_once" ON "silver"."urgent_alert_sends" USING btree ("symbol","kind","item_id") WHERE mode = 'full' and status <> 'failed';