import { and, asc, eq, gte, inArray, isNull, lt } from 'drizzle-orm'
import type { Embedder } from './llm/embedder.ts'
import { EMBEDDING_DIMENSIONS } from './llm/embedder.ts'
import { renderTranscript, type TranscriptAttachment, type TranscriptMessage } from './transcript.ts'
import type { Db } from '../store/client.ts'
import { attachmentDerivations, attachments, messages, participants } from '../store/schema.ts'

const EMBED_BATCH_SIZE = 32

type PendingMessage = {
  id: string
  sentAt: Date
  senderName: string
  text: string | null
}

/**
 * Embeds messages in `[from, to)` that lack `embeddedAt`. Skips rows with
 * neither text nor a cached derivation so a later enrich can fill them in.
 * Processes one batch of up to 32 at a time. Wrong vector dimensions abort
 * the batch with no writes.
 */
export async function embedMissing(
  db: Db,
  embedder: Embedder,
  conversationId: string,
  from: Date,
  to: Date,
): Promise<number> {
  const pending = await listUnembeddedInRange(db, conversationId, from, to)
  if (pending.length === 0) return 0

  const messageIds = pending.map((row) => row.id)
  const messageAttachments = await listAttachmentsForMessages(db, messageIds)
  const derivationMap = await listAnyDerivations(
    db,
    messageAttachments.map((row) => row.id),
  )

  const toEmbed: Array<{ id: string; text: string }> = []
  for (const message of pending) {
    const text = buildEmbedText(message, messageAttachments, derivationMap)
    if (text === null) continue
    toEmbed.push({ id: message.id, text })
  }

  let embedded = 0
  for (let offset = 0; offset < toEmbed.length; offset += EMBED_BATCH_SIZE) {
    const batch = toEmbed.slice(offset, offset + EMBED_BATCH_SIZE)
    const vectors = await embedder.embed(batch.map((item) => item.text))

    if (vectors.length !== batch.length) {
      throw new Error(
        `Embedder returned ${vectors.length} vectors for ${batch.length} texts`,
      )
    }

    for (const vector of vectors) {
      if (vector.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Embedding dimension mismatch: expected ${EMBEDDING_DIMENSIONS}, got ${vector.length}`,
        )
      }
    }

    const now = new Date()
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i]!
      const vector = vectors[i]!
      await db
        .update(messages)
        .set({ embedding: vector, embeddedAt: now })
        .where(eq(messages.id, item.id))
      embedded += 1
    }
  }

  return embedded
}

async function listUnembeddedInRange(
  db: Db,
  conversationId: string,
  from: Date,
  to: Date,
): Promise<PendingMessage[]> {
  const rows = await db
    .select({
      id: messages.id,
      sentAt: messages.sentAt,
      text: messages.text,
      displayName: participants.displayName,
      fromSelf: messages.fromSelf,
    })
    .from(messages)
    .leftJoin(participants, eq(messages.participantId, participants.id))
    .where(
      and(
        eq(messages.conversationId, conversationId),
        gte(messages.sentAt, from),
        lt(messages.sentAt, to),
        isNull(messages.embeddedAt),
      ),
    )
    .orderBy(asc(messages.sentAt))

  return rows.map((row) => ({
    id: row.id,
    sentAt: row.sentAt,
    senderName: row.displayName ?? (row.fromSelf ? 'You' : 'Unknown'),
    text: row.text,
  }))
}

async function listAttachmentsForMessages(
  db: Db,
  messageIds: string[],
): Promise<TranscriptAttachment[]> {
  if (messageIds.length === 0) return []

  const rows = await db
    .select({
      id: attachments.id,
      messageId: attachments.messageId,
      kind: attachments.kind,
      durationMs: attachments.durationMs,
    })
    .from(attachments)
    .where(inArray(attachments.messageId, messageIds))

  return rows.map((row) => ({
    id: row.id,
    messageId: row.messageId,
    kind: row.kind,
    durationMs: row.durationMs,
  }))
}

/** Any cached derivation text per attachment, regardless of model. */
async function listAnyDerivations(
  db: Db,
  attachmentIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (attachmentIds.length === 0) return result

  const rows = await db
    .select({
      attachmentId: attachmentDerivations.attachmentId,
      text: attachmentDerivations.text,
    })
    .from(attachmentDerivations)
    .where(inArray(attachmentDerivations.attachmentId, attachmentIds))

  for (const row of rows) {
    if (!result.has(row.attachmentId)) {
      result.set(row.attachmentId, row.text)
    }
  }
  return result
}

function buildEmbedText(
  message: PendingMessage,
  allAttachments: TranscriptAttachment[],
  derivations: ReadonlyMap<string, string>,
): string | null {
  const messageAttachments = allAttachments.filter((a) => a.messageId === message.id)
  const hasText = message.text != null && message.text !== ''
  const hasDerivation = messageAttachments.some((a) => {
    const text = derivations.get(a.id)
    return text != null && text !== ''
  })

  if (!hasText && !hasDerivation) return null

  if (messageAttachments.length === 0) {
    return message.text ?? ''
  }

  const transcriptMessage: TranscriptMessage = {
    id: message.id,
    sentAt: message.sentAt,
    senderName: message.senderName,
    text: message.text,
  }
  return renderTranscript([transcriptMessage], messageAttachments, undefined, derivations)
}
