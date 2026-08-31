import { createDb } from '../../src/store/client.ts'
import { runMigrations } from '../../src/store/migrate.ts'

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? 'postgres://bot:bot@localhost:5433/botwhatsapp_test'

const TABLES = [
  'pending_clarifications',
  'bot_messages',
  'outbound_messages',
  'chunk_summaries',
  'attachment_derivations',
  'attachments',
  'messages',
  'participants',
  'chat_preferences',
  'conversations',
  'capture_rules',
  'capture_policy',
  'preferences',
] as const

export function openTestDb() {
  return createDb(TEST_DATABASE_URL)
}

export async function resetTestDb(sql: ReturnType<typeof createDb>['sql']): Promise<void> {
  await runMigrations(TEST_DATABASE_URL)
  await sql.unsafe(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`)
}
