import { and, count, eq, gte, lt, max } from 'drizzle-orm'
import type { Db } from '../client.ts'
import { chunkSummaries, messages } from '../schema.ts'

export type ChunkKey = {
  conversationId: string
  day: string
  from: Date
  to: Date
  model: string
  promptVersion: number
}

/**
 * Returns the cached partial summary when the bucket's live message count
 * and last `sent_at` still match the row. Otherwise `null`.
 */
export async function findValidChunk(db: Db, key: ChunkKey): Promise<string | null> {
  const [stats] = await db
    .select({
      messageCount: count(),
      lastMessageAt: max(messages.sentAt),
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, key.conversationId),
        gte(messages.sentAt, key.from),
        lt(messages.sentAt, key.to),
      ),
    )

  const messageCount = Number(stats?.messageCount ?? 0)
  const lastMessageAt = stats?.lastMessageAt ?? null
  if (messageCount === 0 || lastMessageAt == null) return null

  const rows = await db
    .select({
      summaryText: chunkSummaries.summaryText,
      messageCount: chunkSummaries.messageCount,
      lastMessageAt: chunkSummaries.lastMessageAt,
    })
    .from(chunkSummaries)
    .where(
      and(
        eq(chunkSummaries.conversationId, key.conversationId),
        eq(chunkSummaries.day, key.day),
        eq(chunkSummaries.model, key.model),
        eq(chunkSummaries.promptVersion, key.promptVersion),
      ),
    )
    .limit(1)

  const row = rows[0]
  if (!row) return null
  if (row.messageCount !== messageCount) return null
  if (row.lastMessageAt.getTime() !== lastMessageAt.getTime()) return null
  return row.summaryText
}

export async function upsertChunk(
  db: Db,
  key: ChunkKey,
  text: string,
  messageCount: number,
  lastMessageAt: Date,
): Promise<void> {
  await db
    .insert(chunkSummaries)
    .values({
      conversationId: key.conversationId,
      day: key.day,
      model: key.model,
      promptVersion: key.promptVersion,
      messageCount,
      lastMessageAt,
      summaryText: text,
    })
    .onConflictDoUpdate({
      target: [
        chunkSummaries.conversationId,
        chunkSummaries.day,
        chunkSummaries.model,
        chunkSummaries.promptVersion,
      ],
      set: {
        messageCount,
        lastMessageAt,
        summaryText: text,
        updatedAt: new Date(),
      },
    })
}

/**
 * Deletes every cached partial. Call when the global preferences timezone
 * changes: day buckets are delimited in that timezone, so existing rows
 * are no longer aligned to calendar days.
 */
export async function invalidateChunksForTimezoneChange(db: Db): Promise<void> {
  await db.delete(chunkSummaries)
}
