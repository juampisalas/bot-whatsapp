import { resolveConversation, type ConversationHit } from '../agent/resolve-conversation.ts'
import { formatPhoneFromJid } from '../domain/contact-label.ts'
import type { MessagingProvider } from '../domain/provider.ts'
import type { ProviderId } from '../domain/types.ts'
import type { Db } from '../store/client.ts'
import { syncDirectoryToDb } from '../capture/directory.ts'
import { searchNamedContacts } from '../store/repositories/conversations.ts'
import {
  contactActivity,
  contactFound,
  contactOptions,
  contactsNotFound,
  noContact,
  type ReplyLanguage,
} from './i18n.ts'

/** Parses "buscar contacto Gusma", "search contact Gusma", "buscar Gusma en contactos". */
export function parseSearchContactCommand(text: string): string | null {
  const trimmed = text.trim()
  const patterns = [
    /^buscar\s+(.+?)\s+en\s+(?:mis\s+)?contactos$/i,
    /^(?:buscar|search)(?:\s+contacto|\s+contact)?\s+(.+)$/i,
  ]
  for (const pattern of patterns) {
    const match = trimmed.match(pattern)
    const query = match?.[1]?.trim()
    if (query) return query
  }
  return null
}

export function formatContactOption(
  hit: ConversationHit,
  index: number,
  language: ReplyLanguage = 'en',
): string {
  const storedDigits = hit.phoneNumber?.replace(/\D/g, '') ?? ''
  const phone =
    formatPhoneFromJid(hit.externalId) ?? (storedDigits.length >= 6 ? `+${storedDigits}` : null)
  const saved = hit.addressBookName?.trim() || hit.name?.trim()
  const push = hit.pushName?.trim()
  const labelParts: string[] = []
  if (saved) labelParts.push(saved)
  if (push && push !== saved) labelParts.push(`WhatsApp: ${push}`)
  if (phone) labelParts.push(phone)
  const label = labelParts.length > 0 ? labelParts.join(' · ') : hit.externalId
  const activity = contactActivity(language, hit.messageCount)
  return `${index + 1}. ${label} (${activity})`
}

export function formatContactSearchResults(
  query: string,
  hits: ConversationHit[],
  language: ReplyLanguage = 'en',
): string {
  if (hits.length === 0) return contactsNotFound(language, query)

  const exact = hits.filter(
    (hit) =>
      hit.addressBookName?.trim().toLowerCase() === query.trim().toLowerCase() ||
      hit.name?.trim().toLowerCase() === query.trim().toLowerCase(),
  )
  if (exact.length === 1) {
    const hit = exact[0]
    if (!hit) return noContact(language, query)
    const label = hit.addressBookName ?? hit.name ?? formatPhoneFromJid(hit.externalId) ?? query
    return contactFound(language, label)
  }

  const lines = hits.slice(0, 5).map((hit, index) => formatContactOption(hit, index, language))
  return contactOptions(language, query, lines)
}

export async function runContactSearch(
  db: Db,
  provider: ProviderId,
  query: string,
  channel?: MessagingProvider,
  language: ReplyLanguage = 'en',
): Promise<{ hits: ConversationHit[]; text: string }> {
  if (channel?.syncDirectory) {
    await syncDirectoryToDb(db, channel)
  }

  const resolved = await resolveConversation(db, provider, query, { channel })
  if (resolved.kind === 'resolved') {
    const hits = await searchNamedContacts(db, provider, query)
    const hit = hits.find((row) => row.id === resolved.conversationId) ?? hits[0]
    if (hit) {
      return {
        hits: [hit],
        text: formatContactSearchResults(query, [hit], language),
      }
    }
  }

  if (resolved.kind === 'ambiguous') {
    return {
      hits: resolved.candidates,
      text: formatContactSearchResults(query, resolved.candidates, language),
    }
  }

  const hits = await searchNamedContacts(db, provider, query)
  return {
    hits,
    text: formatContactSearchResults(query, hits, language),
  }
}
