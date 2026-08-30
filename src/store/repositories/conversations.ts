import type { Db } from '../client.ts'
import { conversations, participants } from '../schema.ts'
import type { ConversationKind, ProviderId } from '../../domain/types.ts'

/**
 * El `set` del upsert se arma solo con los valores presentes, en lugar de
 * resolver la ausencia con `COALESCE` en SQL. Un nombre nulo significa "el
 * canal no lo informó esta vez", y en ese caso no se toca el que ya
 * teníamos. `updatedAt` garantiza que el `set` nunca quede vacío.
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
  if (!id) throw new Error('upsertConversation no devolvió id')
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
  if (!id) throw new Error('upsertParticipant no devolvió id')
  return id
}
