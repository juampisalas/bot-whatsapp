CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"kind" text NOT NULL,
	"mime_type" text,
	"size_bytes" integer,
	"duration_ms" integer,
	"local_path" text,
	"download_status" text DEFAULT 'pending' NOT NULL,
	"download_attempts" integer DEFAULT 0 NOT NULL,
	"download_error" text
);
--> statement-breakpoint
CREATE TABLE "capture_policy" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"mode" text DEFAULT 'all' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capture_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"conversation_external_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"participant_id" uuid,
	"sent_at" timestamp with time zone NOT NULL,
	"from_self" boolean NOT NULL,
	"text" text,
	"subject" text,
	"thread_external_id" text,
	"reply_to_external_id" text,
	"raw" jsonb,
	"embedding" vector(768),
	"embedded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_message_external_id_idx" ON "attachments" USING btree ("message_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capture_rules_provider_conversation_idx" ON "capture_rules" USING btree ("provider","conversation_external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_provider_external_id_idx" ON "conversations" USING btree ("provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_external_id_idx" ON "messages" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_sent_at_idx" ON "messages" USING btree ("conversation_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "participants_provider_external_id_idx" ON "participants" USING btree ("provider","external_id");