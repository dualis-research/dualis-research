CREATE TABLE "silver"."emphasis" (
	"key" text PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"emphasized" text,
	"ok" boolean NOT NULL,
	"error" text,
	"model" text,
	"bronze_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gold"."emphasis" (
	"key" text PRIMARY KEY NOT NULL,
	"emphasized" text NOT NULL,
	"rebuilt_at" timestamp with time zone DEFAULT now() NOT NULL
);
