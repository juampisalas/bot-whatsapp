import { embedMissing } from './embed.ts'
import type { Embedder } from './llm/embedder.ts'
import type { Db } from '../store/client.ts'
import { searchSimilar } from '../store/repositories/embeddings.ts'
import {
  listMessagesInRange,
  type RangeMessage,
} from '../store/repositories/message-range.ts'

/**
 * Lazy topic search over `[from, to)`: embed missing messages, embed the
 * topic once, then return similar hits in chronological order for transcripts.
 */
export async function searchByTopic(
  db: Db,
  embedder: Embedder,
  conversationId: string,
  from: Date,
  to: Date,
  topic: string,
): Promise<RangeMessage[]> {
  await embedMissing(db, embedder, conversationId, from, to)

  const [queryVector] = await embedder.embed([topic])
  if (queryVector == null) return []

  const similar = await searchSimilar(db, conversationId, from, to, queryVector)
  if (similar.length === 0) return []

  const hitIds = new Set(similar.map((row) => row.id))
  const loaded = await listMessagesInRange(db, conversationId, from, to)
  return loaded.messages.filter((message) => hitIds.has(message.id))
}
