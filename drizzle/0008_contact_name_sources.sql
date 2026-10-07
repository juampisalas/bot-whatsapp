CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "address_book_name" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "push_name" text;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN IF NOT EXISTS "address_book_name" text;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN IF NOT EXISTS "push_name" text;--> statement-breakpoint
UPDATE "conversations"
SET "push_name" = "name"
WHERE "kind" = 'dm'
  AND "address_book_name" IS NULL
  AND "push_name" IS NULL
  AND "name" IS NOT NULL;--> statement-breakpoint
UPDATE "participants"
SET "push_name" = "display_name"
WHERE "address_book_name" IS NULL
  AND "push_name" IS NULL
  AND "display_name" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_name_trgm_idx"
ON "conversations" USING gin (lower(COALESCE("name", '')) gin_trgm_ops);
