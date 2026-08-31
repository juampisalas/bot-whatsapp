import { and, cosineDistance, desc, eq, gt, gte, isNotNull, lt, sql } from 'drizzle-orm'
import type { Db } from '../client.ts'
import { messages } from '../schema.ts'

export type SimilarMessage = {
  id: string
  text: string | null
  sentAt: Date
  similarity: number
}

const DEFAULT_SIMILARITY_LIMIT = 20
const MIN_SIMILARITY = 0.3

/**
 * Cosine similarity search over messages that already have embeddings.
 * Always scoped to one conversation and a half-open `[from, to)` window.
 */
export async function searchSimilar(
  db: Db,
  conversationId: string,
  from: Date,
  to: Date,
  queryVector: number[],
  limit: number = DEFAULT_SIMILARITY_LIMIT,
): Promise<SimilarMessage[]> {
  const similarity = sql<number>`1 - (${cosineDistance(messages.embedding, queryVector)})`

  const rows = await db
    .select({
      id: messages.id,
      text: messages.text,
      sentAt: messages.sentAt,
      similarity,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        gte(messages.sentAt, from),
        lt(messages.sentAt, to),
        isNotNull(messages.embedding),
        gt(similarity, MIN_SIMILARITY),
      ),
    )
    .orderBy((t) => desc(t.similarity))
    .limit(limit)

  return rows.map((row) => ({
    id: row.id,
    text: row.text,
    sentAt: row.sentAt,
    similarity: Number(row.similarity),
  }))
}
