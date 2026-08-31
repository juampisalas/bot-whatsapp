import { and, eq, sql } from 'drizzle-orm'
import type { ProviderId } from '../../domain/types.ts'
import type { Db } from '../client.ts'
import { chatPreferences, conversations, preferences } from '../schema.ts'
import { invalidateChunksForTimezoneChange } from './chunks.ts'

export type GlobalPreferencesRow = typeof preferences.$inferSelect
export type ChatPreferencesRow = typeof chatPreferences.$inferSelect

export type GlobalPreferencesPatch = {
  language?: string | null
  length?: string | null
  format?: string | null
  tone?: string | null
  timezone?: string | null
}

export type ChatPreferencesPatch = {
  language?: string | null
  length?: string | null
  format?: string | null
  tone?: string | null
  timezone?: string | null
  focus?: string | null
  ignoreKinds?: string[]
  alias?: string | null
}

export async function loadGlobalPreferences(db: Db): Promise<GlobalPreferencesRow | null> {
  const rows = await db.select().from(preferences).limit(1)
  return rows[0] ?? null
}

export async function loadChatPreferences(
  db: Db,
  conversationId: string,
): Promise<ChatPreferencesRow | null> {
  const rows = await db
    .select()
    .from(chatPreferences)
    .where(eq(chatPreferences.conversationId, conversationId))
    .limit(1)
  return rows[0] ?? null
}

/**
 * Upserts the singleton global preferences row.
 * When `timezone` changes, deletes all `chunk_summaries` because day buckets
 * are delimited in that timezone.
 */
export async function upsertGlobalPreferences(
  db: Db,
  patch: GlobalPreferencesPatch,
): Promise<void> {
  let timezoneChanged = false
  if (patch.timezone !== undefined) {
    const current = await loadGlobalPreferences(db)
    timezoneChanged = (current?.timezone ?? null) !== patch.timezone
  }

  await db
    .insert(preferences)
    .values({
      id: 1,
      language: patch.language ?? null,
      length: patch.length ?? null,
      format: patch.format ?? null,
      tone: patch.tone ?? null,
      timezone: patch.timezone ?? null,
    })
    .onConflictDoUpdate({
      target: preferences.id,
      set: {
        ...(patch.language !== undefined ? { language: patch.language } : {}),
        ...(patch.length !== undefined ? { length: patch.length } : {}),
        ...(patch.format !== undefined ? { format: patch.format } : {}),
        ...(patch.tone !== undefined ? { tone: patch.tone } : {}),
        ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
        updatedAt: new Date(),
      },
    })

  if (timezoneChanged) {
    await invalidateChunksForTimezoneChange(db)
  }
}

export async function upsertChatPreferences(
  db: Db,
  conversationId: string,
  patch: ChatPreferencesPatch,
): Promise<void> {
  await db
    .insert(chatPreferences)
    .values({
      conversationId,
      language: patch.language ?? null,
      length: patch.length ?? null,
      format: patch.format ?? null,
      tone: patch.tone ?? null,
      timezone: patch.timezone ?? null,
      focus: patch.focus ?? null,
      ignoreKinds: patch.ignoreKinds ?? [],
      alias: patch.alias ?? null,
    })
    .onConflictDoUpdate({
      target: chatPreferences.conversationId,
      set: {
        ...(patch.language !== undefined ? { language: patch.language } : {}),
        ...(patch.length !== undefined ? { length: patch.length } : {}),
        ...(patch.format !== undefined ? { format: patch.format } : {}),
        ...(patch.tone !== undefined ? { tone: patch.tone } : {}),
        ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
        ...(patch.focus !== undefined ? { focus: patch.focus } : {}),
        ...(patch.ignoreKinds !== undefined ? { ignoreKinds: patch.ignoreKinds } : {}),
        ...(patch.alias !== undefined ? { alias: patch.alias } : {}),
        updatedAt: new Date(),
      },
    })
}

export async function findConversationIdByAlias(
  db: Db,
  provider: ProviderId,
  alias: string,
): Promise<string | null> {
  const rows = await db
    .select({ conversationId: chatPreferences.conversationId })
    .from(chatPreferences)
    .innerJoin(conversations, eq(conversations.id, chatPreferences.conversationId))
    .where(
      and(
        eq(conversations.provider, provider),
        sql`lower(${chatPreferences.alias}) = lower(${alias})`,
      ),
    )
    .limit(1)
  return rows[0]?.conversationId ?? null
}
