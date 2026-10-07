import type { MessagingProvider } from '../domain/provider.ts'
import type { ProviderId } from '../domain/types.ts'
import type { Db } from '../store/client.ts'
import {
  resolveConversationCandidates,
  searchNamedContacts,
  type ConversationHit,
} from '../store/repositories/conversations.ts'
import { syncDirectoryToDb } from '../capture/directory.ts'
import { findConversationIdByAlias } from '../store/repositories/preferences.ts'

export type { ConversationHit }

export type ResolveResult =
  | { kind: 'resolved'; conversationId: string }
  | { kind: 'ambiguous'; candidates: ConversationHit[] }
  | { kind: 'none' }

export type ResolveConversationOptions = {
  /** When set, triggers a directory sync from the channel before giving up. */
  channel?: MessagingProvider
}

function preferConversation(a: ConversationHit, b: ConversationHit): ConversationHit {
  if (a.messageCount !== b.messageCount) {
    return a.messageCount > b.messageCount ? a : b
  }
  const aIsLid = a.externalId.endsWith('@lid')
  const bIsLid = b.externalId.endsWith('@lid')
  if (aIsLid !== bIsLid) return aIsLid ? a : b

  const aTime = a.lastMessageAt?.getTime() ?? 0
  const bTime = b.lastMessageAt?.getTime() ?? 0
  return aTime >= bTime ? a : b
}

function phoneDigitsFromHit(hit: ConversationHit): string | null {
  const stored = hit.phoneNumber?.replace(/\D/g, '') ?? ''
  if (stored.length >= 6) return stored
  if (!hit.externalId.endsWith('@s.whatsapp.net')) return null
  const fromJid = hit.externalId.replace(/\D/g, '')
  return fromJid.length >= 6 ? fromJid : null
}

function nameDedupeKey(hit: ConversationHit): string {
  const label = (hit.addressBookName ?? hit.name)?.trim().toLowerCase()
  if (label && label.length > 0) return `name:${label}`
  return `id:${hit.externalId}`
}

/** Collapses duplicate hits that share a phone number or the same visible label. */
function dedupeCandidates(hits: ConversationHit[]): ConversationHit[] {
  const byPhone = new Map<string, ConversationHit>()
  const rest: ConversationHit[] = []
  for (const hit of hits) {
    const phone = hit.kind === 'dm' ? phoneDigitsFromHit(hit) : null
    if (phone) {
      const existing = byPhone.get(phone)
      byPhone.set(phone, existing ? preferConversation(existing, hit) : hit)
    } else {
      rest.push(hit)
    }
  }

  const byName = new Map<string, ConversationHit>()
  for (const hit of [...byPhone.values(), ...rest]) {
    const key = nameDedupeKey(hit)
    const existing = byName.get(key)
    byName.set(key, existing ? preferConversation(existing, hit) : hit)
  }
  return [...byName.values()]
}

function exactNameMatches(hits: ConversationHit[], spokenName: string): ConversationHit[] {
  const normalized = spokenName.trim().toLowerCase()
  return hits.filter((hit) => {
    const labels = [hit.name, hit.addressBookName, hit.pushName]
    return labels.some((label) => label?.trim().toLowerCase() === normalized)
  })
}

async function resolveOnce(
  db: Db,
  provider: ProviderId,
  spokenName: string,
): Promise<ResolveResult> {
  const aliasId = await findConversationIdByAlias(db, provider, spokenName)
  if (aliasId !== null) {
    return { kind: 'resolved', conversationId: aliasId }
  }

  const hits = dedupeCandidates(await resolveConversationCandidates(db, provider, spokenName))
  if (hits.length === 0) return { kind: 'none' }

  const named = dedupeCandidates(exactNameMatches(hits, spokenName))
  if (named.length === 1) {
    const only = named[0]
    if (!only) return { kind: 'none' }
    return { kind: 'resolved', conversationId: only.id }
  }
  if (named.length > 1) {
    return { kind: 'ambiguous', candidates: named.slice(0, 3) }
  }

  const exact = hits.filter((hit) => hit.matchType === 'exact')
  if (exact.length === 1) {
    const only = exact[0]
    if (!only) return { kind: 'none' }
    return { kind: 'resolved', conversationId: only.id }
  }

  if (exact.length > 1) {
    return { kind: 'ambiguous', candidates: exact.slice(0, 3) }
  }

  const contactHits = dedupeCandidates(await searchNamedContacts(db, provider, spokenName))
  if (contactHits.length === 1) {
    const only = contactHits[0]
    if (!only) return { kind: 'none' }
    return { kind: 'resolved', conversationId: only.id }
  }
  if (contactHits.length > 1) {
    return { kind: 'ambiguous', candidates: contactHits.slice(0, 3) }
  }

  if (hits.length === 1) {
    const only = hits[0]
    if (!only) return { kind: 'none' }
    return { kind: 'resolved', conversationId: only.id }
  }

  return { kind: 'ambiguous', candidates: hits.slice(0, 3) }
}

function shouldSyncOnMiss(result: ResolveResult): boolean {
  if (result.kind === 'none') return true
  if (result.kind !== 'ambiguous') return false
  return result.candidates.every(
    (hit) => hit.matchType === 'fuzzy' && hit.kind === 'group' && hit.messageCount === 0,
  )
}

/**
 * Resolves a spoken conversation name: alias first (case-insensitive),
 * then substring search, phone digits, synced contacts, fuzzy similarity.
 * When nothing matches and a channel is available, syncs the contact directory once and retries.
 */
export async function resolveConversation(
  db: Db,
  provider: ProviderId,
  spokenName: string,
  options: ResolveConversationOptions = {},
): Promise<ResolveResult> {
  let result = await resolveOnce(db, provider, spokenName)
  if (!shouldSyncOnMiss(result) || !options.channel?.syncDirectory) {
    return result
  }

  await syncDirectoryToDb(db, options.channel)
  result = await resolveOnce(db, provider, spokenName)
  if (result.kind === 'ambiguous' && shouldSyncOnMiss(result)) {
    return { kind: 'none' }
  }
  return result
}
