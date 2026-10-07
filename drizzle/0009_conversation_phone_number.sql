ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "phone_number" text;--> statement-breakpoint
UPDATE "conversations"
SET "phone_number" = regexp_replace(split_part("external_id", '@', 1), '[^0-9]', '', 'g')
WHERE "kind" = 'dm'
  AND "external_id" LIKE '%@s.whatsapp.net'
  AND ("phone_number" IS NULL OR "phone_number" = '');
