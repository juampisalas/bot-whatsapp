CREATE TABLE "bot_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"outbound_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"conversation_external_id" text NOT NULL,
	"text" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"sent_external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_clarifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"conversation_external_id" text NOT NULL,
	"original_text" text NOT NULL,
	"question" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_messages" ADD CONSTRAINT "bot_messages_outbound_id_outbound_messages_id_fk" FOREIGN KEY ("outbound_id") REFERENCES "public"."outbound_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_messages_provider_external_id_idx" ON "bot_messages" USING btree ("provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_messages_idempotency_key_idx" ON "outbound_messages" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "outbound_messages_due_idx" ON "outbound_messages" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pending_clarifications_provider_conversation_idx" ON "pending_clarifications" USING btree ("provider","conversation_external_id");