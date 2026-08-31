import type { ProviderId } from '../domain/types.ts'
import type { Db } from '../store/client.ts'
import {
  searchConversationsByName,
  type ConversationHit,
} from '../store/repositories/conversations.ts'
import { findConversationIdByAlias } from '../store/repositories/preferences.ts'

export type { ConversationHit }

export type ResolveResult =
  | { kind: 'resolved'; conversationId: string }
  | { kind: 'ambiguous'; candidates: ConversationHit[] }
  | { kind: 'none' }

/**
 * Resolves a spoken conversation name: alias first (case-insensitive),
 * then ILIKE name search. Ambiguous hits are returned to the caller;
 * this function never picks among them.
 */
export async function resolveConversation(
  db: Db,
  provider: ProviderId,
  spokenName: string,
): Promise<ResolveResult> {
  const aliasId = await findConversationIdByAlias(db, provider, spokenName)
  if (aliasId !== null) {
    return { kind: 'resolved', conversationId: aliasId }
  }

  const hits = await searchConversationsByName(db, provider, spokenName)
  if (hits.length === 0) return { kind: 'none' }
  if (hits.length === 1) {
    const only = hits[0]
    if (!only) return { kind: 'none' }
    return { kind: 'resolved', conversationId: only.id }
  }
  return { kind: 'ambiguous', candidates: hits }
}
