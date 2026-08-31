import { and, eq, inArray, lte, sql } from 'drizzle-orm'
import type { ProviderId } from '../../domain/types.ts'
import type { Db } from '../client.ts'
import { outboundMessages } from '../schema.ts'

export type OutboundRow = typeof outboundMessages.$inferSelect

export interface EnqueueOutboundInput {
  provider: ProviderId
  conversationExternalId: string
  text: string
  idempotencyKey: string
}

export async function enqueueOutbound(
  db: Db,
  input: EnqueueOutboundInput,
): Promise<{ id: string }> {
  const inserted = await db
    .insert(outboundMessages)
    .values({
      provider: input.provider,
      conversationExternalId: input.conversationExternalId,
      text: input.text,
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing({ target: outboundMessages.idempotencyKey })
    .returning({ id: outboundMessages.id })

  const id = inserted[0]?.id
  if (id) return { id }

  const existing = await db
    .select({ id: outboundMessages.id })
    .from(outboundMessages)
    .where(eq(outboundMessages.idempotencyKey, input.idempotencyKey))
    .limit(1)

  const existingId = existing[0]?.id
  if (!existingId) {
    throw new Error('enqueueOutbound could not resolve existing outbound message')
  }
  return { id: existingId }
}

export async function claimDueOutbound(
  db: Db,
  now: Date,
  limit: number,
): Promise<OutboundRow[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(outboundMessages)
      .where(
        and(eq(outboundMessages.status, 'pending'), lte(outboundMessages.nextAttemptAt, now)),
      )
      .orderBy(outboundMessages.nextAttemptAt)
      .limit(limit)
      .for('update', { skipLocked: true })

    if (due.length === 0) return []

    const ids = due.map((row) => row.id)
    await tx
      .update(outboundMessages)
      .set({
        status: 'sending',
        attempts: sql`${outboundMessages.attempts} + 1`,
        updatedAt: now,
      })
      .where(inArray(outboundMessages.id, ids))

    return due.map((row) => ({
      ...row,
      status: 'sending' as const,
      attempts: row.attempts + 1,
    }))
  })
}

export async function markOutboundSent(
  db: Db,
  id: string,
  sentExternalId: string,
): Promise<void> {
  await db
    .update(outboundMessages)
    .set({
      status: 'sent',
      sentExternalId,
      updatedAt: new Date(),
    })
    .where(eq(outboundMessages.id, id))
}

export async function markOutboundFailed(
  db: Db,
  id: string,
  error: string,
  nextAttemptAt: Date,
  terminal = false,
): Promise<void> {
  await db
    .update(outboundMessages)
    .set({
      status: terminal ? 'failed' : 'pending',
      lastError: error,
      nextAttemptAt,
      updatedAt: new Date(),
    })
    .where(eq(outboundMessages.id, id))
}
