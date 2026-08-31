import { and, count, desc, eq, ilike } from 'drizzle-orm'
import type { ConversationKind, ProviderId } from '../../domain/types.ts'
import type { Db } from '../client.ts'
import { conversations, messages, participants } from '../schema.ts'

export type ConversationHit = {
  id: string
  name: string | null
  lastMessageAt: Date | null
  messageCount: number
}

/**
 * Builds the upsert `set` from present values only, instead of resolving
 * absence with SQL `COALESCE`. A null name means "the channel did not
 * report it this time", so the existing name is left alone. `updatedAt`
 * ensures the `set` is never empty.
 */
export async function upsertConversation(
  db: Db,
  input: { provider: ProviderId; externalId: string; kind: ConversationKind; name: string | null },
): Promise<string> {
  const rows = await db
    .insert(conversations)
    .values({
      provider: input.provider,
      externalId: input.externalId,
      kind: input.kind,
      name: input.name,
    })
    .onConflictDoUpdate({
      target: [conversations.provider, conversations.externalId],
      set: {
        kind: input.kind,
        ...(input.name === null ? {} : { name: input.name }),
        updatedAt: new Date(),
      },
    })
    .returning({ id: conversations.id })

  const id = rows[0]?.id
  if (!id) throw new Error('upsertConversation did not return an id')
  return id
}

export async function upsertParticipant(
  db: Db,
  input: { provider: ProviderId; externalId: string; displayName: string | null },
): Promise<string> {
  const rows = await db
    .insert(participants)
    .values({
      provider: input.provider,
      externalId: input.externalId,
      displayName: input.displayName,
    })
    .onConflictDoUpdate({
      target: [participants.provider, participants.externalId],
      set: {
        ...(input.displayName === null ? {} : { displayName: input.displayName }),
        updatedAt: new Date(),
      },
    })
    .returning({ id: participants.id })

  const id = rows[0]?.id
  if (!id) throw new Error('upsertParticipant did not return an id')
  return id
}

/**
 * Case-insensitive substring match on conversation name for a provider.
 * Ordered by recent activity; capped at 5 hits.
 */
export async function searchConversationsByName(
  db: Db,
  provider: ProviderId,
  query: string,
): Promise<ConversationHit[]> {
  const rows = await db
    .select({
      id: conversations.id,
      name: conversations.name,
      lastMessageAt: conversations.lastMessageAt,
      messageCount: count(messages.id),
    })
    .from(conversations)
    .leftJoin(messages, eq(messages.conversationId, conversations.id))
    .where(and(eq(conversations.provider, provider), ilike(conversations.name, `%${query}%`)))
    .groupBy(conversations.id)
    .orderBy(desc(conversations.lastMessageAt))
    .limit(5)

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    lastMessageAt: row.lastMessageAt,
    messageCount: Number(row.messageCount),
  }))
}
