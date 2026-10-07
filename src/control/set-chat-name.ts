import { resolveConversation } from '../agent/resolve-conversation.ts'
import { formatPhoneFromJid } from '../domain/contact-label.ts'
import type { MessagingProvider } from '../domain/provider.ts'
import type { ProviderId } from '../domain/types.ts'
import type { Db } from '../store/client.ts'
import { syncAddressBookName, type ConversationHit } from '../store/repositories/conversations.ts'
import { upsertChatPreferences } from '../store/repositories/preferences.ts'
import { conversations } from '../store/schema.ts'
import { eq } from 'drizzle-orm'
import { BOT_PREFIX } from './classify.ts'
import { chatNameSaved, chatNotFound, whichChat, type ReplyLanguage } from './i18n.ts'

export type SetChatNameInput = {
  displayName: string
  targetQuery: string
}

/** Parses "name Mariano Mangialavori for Marian" / "nombre X para Y". */
export function parseSetChatNameCommand(text: string): SetChatNameInput | null {
  const match = text.trim().match(/^(?:name|nombre)\s+(.+?)\s+(?:for|para)\s+(.+)$/i)
  if (!match) return null
  const displayName = match[1]?.trim() ?? ''
  const targetQuery = match[2]?.trim() ?? ''
  if (!displayName || !targetQuery) return null
  return { displayName, targetQuery }
}

export async function applySetChatNameCommand(
  db: Db,
  provider: ProviderId,
  input: SetChatNameInput,
  channel?: MessagingProvider,
  language: ReplyLanguage = 'en',
): Promise<string> {
  const resolved = await resolveConversation(db, provider, input.targetQuery, { channel })
  if (resolved.kind === 'none') {
    return chatNotFound(language, input.targetQuery)
  }

  if (resolved.kind === 'ambiguous') {
    return `${BOT_PREFIX}${whichChat(language, formatPickChatLines(resolved.candidates))}`
  }

  const [row] = await db
    .select({
      id: conversations.id,
      externalId: conversations.externalId,
      kind: conversations.kind,
      name: conversations.name,
    })
    .from(conversations)
    .where(eq(conversations.id, resolved.conversationId))
    .limit(1)

  if (!row) {
    return chatNotFound(language, input.targetQuery)
  }

  await syncAddressBookName(db, provider, {
    externalIds: [row.externalId],
    name: input.displayName,
  })
  await upsertChatPreferences(db, row.id, { alias: input.displayName })

  const label = row.name ?? formatPhoneFromJid(row.externalId) ?? row.externalId
  return chatNameSaved(language, input.displayName, label, row.kind)
}

function formatPickChatLines(hits: ConversationHit[]): string[] {
  return hits.slice(0, 3).map((hit, index) => {
    const label = hit.name ?? formatPhoneFromJid(hit.externalId) ?? '(unnamed)'
    return `${index + 1}. ${label} (${hit.kind})`
  })
}
