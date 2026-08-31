CREATE TABLE "chunk_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"day" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"message_count" integer NOT NULL,
	"last_message_at" timestamp with time zone NOT NULL,
	"summary_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chunk_summaries" ADD CONSTRAINT "chunk_summaries_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chunk_summaries_conversation_day_model_prompt_idx" ON "chunk_summaries" USING btree ("conversation_id","day","model","prompt_version");