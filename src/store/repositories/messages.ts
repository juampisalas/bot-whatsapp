import { and, count, eq, sql } from 'drizzle-orm'
import type { Db } from '../client.ts'
import { conversations, messages } from '../schema.ts'
import type { ProviderId } from '../../domain/types.ts'

export interface InsertMessageInput {
  provider: ProviderId
  externalId: string
  conversationId: string
  participantId: string | null
  sentAt: Date
  fromSelf: boolean
  text: string | null
  subject: string | null
  threadExternalId: string | null
  replyToExternalId: string | null
  raw: unknown
}

export async function insertMessage(
  db: Db,
  input: InsertMessageInput,
): Promise<{ id: string; inserted: boolean }> {
  const inserted = await db
    .insert(messages)
    .values({
      provider: input.provider,
      externalId: input.externalId,
      conversationId: input.conversationId,
      participantId: input.participantId,
      sentAt: input.sentAt,
      fromSelf: input.fromSelf,
      text: input.text,
      subject: input.subject,
      threadExternalId: input.threadExternalId,
      replyToExternalId: input.replyToExternalId,
      raw: input.raw,
    })
    .onConflictDoNothing({ target: [messages.provider, messages.externalId] })
    .returning({ id: messages.id })

  const nuevoId = inserted[0]?.id
  if (nuevoId) {
    // La expresión raw debe vincular el encoder de la columna; una interpolación directa entrega un Date sin codificar a postgres.js.
    await db
      .update(conversations)
      .set({
        lastMessageAt: sql`GREATEST(
          COALESCE(${conversations.lastMessageAt}, ${sql.param(input.sentAt, conversations.lastMessageAt)}),
          ${sql.param(input.sentAt, conversations.lastMessageAt)}
        )`,
      })
      .where(eq(conversations.id, input.conversationId))
    return { id: nuevoId, inserted: true }
  }

  const existente = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.provider, input.provider), eq(messages.externalId, input.externalId)))
    .limit(1)

  const id = existente[0]?.id
  if (!id) throw new Error('insertMessage no pudo resolver el mensaje existente')
  return { id, inserted: false }
}

export async function countMessagesInConversation(db: Db, conversationId: string): Promise<number> {
  const rows = await db
    .select({ total: count() })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
  return Number(rows[0]?.total ?? 0)
}
