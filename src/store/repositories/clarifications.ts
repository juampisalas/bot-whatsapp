import { and, eq, gt } from 'drizzle-orm'
import type { ProviderId } from '../../domain/types.ts'
import type { Db } from '../client.ts'
import { pendingClarifications } from '../schema.ts'

export type Clarification = typeof pendingClarifications.$inferSelect

export interface SaveClarificationInput {
  provider: ProviderId
  conversationExternalId: string
  originalText: string
  question: string
  expiresAt: Date
}

export async function saveClarification(db: Db, input: SaveClarificationInput): Promise<void> {
  await db
    .insert(pendingClarifications)
    .values({
      provider: input.provider,
      conversationExternalId: input.conversationExternalId,
      originalText: input.originalText,
      question: input.question,
      expiresAt: input.expiresAt,
    })
    .onConflictDoUpdate({
      target: [pendingClarifications.provider, pendingClarifications.conversationExternalId],
      set: {
        originalText: input.originalText,
        question: input.question,
        expiresAt: input.expiresAt,
      },
    })
}

export async function loadActiveClarification(
  db: Db,
  provider: ProviderId,
  conversationExternalId: string,
  now: Date,
): Promise<Clarification | null> {
  const rows = await db
    .select()
    .from(pendingClarifications)
    .where(
      and(
        eq(pendingClarifications.provider, provider),
        eq(pendingClarifications.conversationExternalId, conversationExternalId),
        gt(pendingClarifications.expiresAt, now),
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

export async function clearClarification(
  db: Db,
  provider: ProviderId,
  conversationExternalId: string,
): Promise<void> {
  await db
    .delete(pendingClarifications)
    .where(
      and(
        eq(pendingClarifications.provider, provider),
        eq(pendingClarifications.conversationExternalId, conversationExternalId),
      ),
    )
}
