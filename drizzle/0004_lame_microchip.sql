CREATE TABLE "chat_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"language" text,
	"length" text,
	"format" text,
	"tone" text,
	"timezone" text,
	"focus" text,
	"ignore_kinds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"alias" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preferences" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"language" text,
	"length" text,
	"format" text,
	"tone" text,
	"timezone" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preferences_id_must_be_one" CHECK ("preferences"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "chat_preferences" ADD CONSTRAINT "chat_preferences_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_preferences_conversation_id_idx" ON "chat_preferences" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_preferences_alias_idx" ON "chat_preferences" USING btree (lower("alias"));