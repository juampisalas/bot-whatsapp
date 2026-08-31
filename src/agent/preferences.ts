import type { Db } from '../store/client.ts'
import {
  loadChatPreferences,
  loadGlobalPreferences,
} from '../store/repositories/preferences.ts'

export const DEFAULT_PREFERENCES = {
  language: 'es',
  length: 'medium',
  format: 'bullets',
  tone: 'neutral',
  timezone: 'America/Argentina/Buenos_Aires',
  focus: null,
  ignoreKinds: [] as string[],
  alias: null,
} as const

export type ResolvedPreferences = {
  language: string
  length: string
  format: string
  tone: string
  timezone: string
  focus: string | null
  ignoreKinds: string[]
  alias: string | null
}

export type GlobalPreferencesInput = {
  language: string | null
  length: string | null
  format: string | null
  tone: string | null
  timezone: string | null
}

export type ChatPreferencesInput = {
  language: string | null
  length: string | null
  format: string | null
  tone: string | null
  timezone: string | null
  focus: string | null
  ignoreKinds: string[] | null
  alias: string | null
}

function pick<T>(chat: T | null | undefined, global: T | null | undefined, fallback: T): T {
  if (chat !== null && chat !== undefined) return chat
  if (global !== null && global !== undefined) return global
  return fallback
}

export function resolvePreferences(
  global: GlobalPreferencesInput | null,
  chat: ChatPreferencesInput | null,
): ResolvedPreferences {
  return {
    language: pick(chat?.language, global?.language, DEFAULT_PREFERENCES.language),
    length: pick(chat?.length, global?.length, DEFAULT_PREFERENCES.length),
    format: pick(chat?.format, global?.format, DEFAULT_PREFERENCES.format),
    tone: pick(chat?.tone, global?.tone, DEFAULT_PREFERENCES.tone),
    timezone: pick(chat?.timezone, global?.timezone, DEFAULT_PREFERENCES.timezone),
    focus: pick(chat?.focus, null, DEFAULT_PREFERENCES.focus),
    ignoreKinds: pick(chat?.ignoreKinds, null, [...DEFAULT_PREFERENCES.ignoreKinds]),
    alias: pick(chat?.alias, null, DEFAULT_PREFERENCES.alias),
  }
}

export async function getResolvedPreferences(
  db: Db,
  conversationId: string | null,
): Promise<ResolvedPreferences> {
  const globalRow = await loadGlobalPreferences(db)
  const chatRow =
    conversationId === null ? null : await loadChatPreferences(db, conversationId)

  return resolvePreferences(
    globalRow
      ? {
          language: globalRow.language,
          length: globalRow.length,
          format: globalRow.format,
          tone: globalRow.tone,
          timezone: globalRow.timezone,
        }
      : null,
    chatRow
      ? {
          language: chatRow.language,
          length: chatRow.length,
          format: chatRow.format,
          tone: chatRow.tone,
          timezone: chatRow.timezone,
          focus: chatRow.focus,
          ignoreKinds: chatRow.ignoreKinds,
          alias: chatRow.alias,
        }
      : null,
  )
}

export {
  findConversationIdByAlias,
  upsertChatPreferences,
  upsertGlobalPreferences,
} from '../store/repositories/preferences.ts'
