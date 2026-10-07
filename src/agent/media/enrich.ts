import { and, eq, gte, inArray, lt } from 'drizzle-orm'
import { describeError, silentLogger, type Logger } from '../../domain/logger.ts'
import type { MessagingProvider } from '../../domain/provider.ts'
import type { AttachmentKind, InboundMessage, ProviderId } from '../../domain/types.ts'
import type { Db } from '../../store/client.ts'
import { decodeRaw } from '../../store/raw.ts'
import {
  markAttachmentDownloaded,
  markAttachmentFailed,
} from '../../store/repositories/attachments.ts'
import { getDerivation, upsertDerivation } from '../../store/repositories/derivations.ts'
import { attachments, conversations, messages } from '../../store/schema.ts'
import { inferChatLanguagePrior } from './chat-language.ts'
import type { MediaModel } from './port.ts'

const ENRICH_CONCURRENCY = 2
const MAX_DOWNLOAD_ATTEMPTS = 3

type EnrichAttachment = {
  id: string
  externalId: string
  kind: AttachmentKind
  mimeType: string | null
  sizeBytes: number | null
  durationMs: number | null
  localPath: string | null
  downloadStatus: string
  downloadAttempts: number
  messageId: string
  messageExternalId: string
  messageProvider: ProviderId
  messageSentAt: Date
  messageFromSelf: boolean
  messageText: string | null
  messageSubject: string | null
  messageThreadExternalId: string | null
  messageReplyToExternalId: string | null
  messageRaw: unknown
  conversationExternalId: string
  conversationKind: InboundMessage['conversation']['kind']
  conversationName: string | null
}

function derivationModelFor(media: MediaModel, kind: 'transcript' | 'description'): string {
  return kind === 'transcript' ? media.transcriptModel : media.describeModel
}

async function loadMessageTextsForPrior(
  db: Db,
  conversationId: string,
  from: Date,
  to: Date,
): Promise<string[]> {
  const rows = await db
    .select({ text: messages.text })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        gte(messages.sentAt, from),
        lt(messages.sentAt, to),
      ),
    )

  return rows
    .map((row) => row.text)
    .filter((text): text is string => text != null && text.trim() !== '')
}

function derivationKindFor(kind: AttachmentKind): 'transcript' | 'description' | null {
  if (kind === 'audio') return 'transcript'
  if (kind === 'image') return 'description'
  return null
}

async function listEnrichableAttachments(
  db: Db,
  conversationId: string,
  from: Date,
  to: Date,
): Promise<EnrichAttachment[]> {
  const rows = await db
    .select({
      id: attachments.id,
      externalId: attachments.externalId,
      kind: attachments.kind,
      mimeType: attachments.mimeType,
      sizeBytes: attachments.sizeBytes,
      durationMs: attachments.durationMs,
      localPath: attachments.localPath,
      downloadStatus: attachments.downloadStatus,
      downloadAttempts: attachments.downloadAttempts,
      messageId: messages.id,
      messageExternalId: messages.externalId,
      messageProvider: messages.provider,
      messageSentAt: messages.sentAt,
      messageFromSelf: messages.fromSelf,
      messageText: messages.text,
      messageSubject: messages.subject,
      messageThreadExternalId: messages.threadExternalId,
      messageReplyToExternalId: messages.replyToExternalId,
      messageRaw: messages.raw,
      conversationExternalId: conversations.externalId,
      conversationKind: conversations.kind,
      conversationName: conversations.name,
    })
    .from(attachments)
    .innerJoin(messages, eq(attachments.messageId, messages.id))
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(messages.conversationId, conversationId),
        gte(messages.sentAt, from),
        lt(messages.sentAt, to),
        inArray(attachments.kind, ['audio', 'image']),
      ),
    )

  return rows
}

function toInboundMessage(row: EnrichAttachment): InboundMessage {
  return {
    provider: row.messageProvider,
    externalId: row.messageExternalId,
    conversation: {
      externalId: row.conversationExternalId,
      kind: row.conversationKind,
      name: row.conversationName,
    },
    sender: null,
    sentAt: row.messageSentAt,
    fromSelf: row.messageFromSelf,
    text: row.messageText,
    subject: row.messageSubject,
    threadExternalId: row.messageThreadExternalId,
    replyToExternalId: row.messageReplyToExternalId,
    attachments: [
      {
        externalId: row.externalId,
        kind: row.kind,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        durationMs: row.durationMs,
      },
    ],
    raw: decodeRaw(row.messageRaw),
  }
}

async function ensureDownloaded(
  db: Db,
  provider: MessagingProvider,
  row: EnrichAttachment,
  log: Logger,
): Promise<string | null> {
  if (row.downloadStatus === 'ok' && row.localPath) {
    return row.localPath
  }

  if (row.downloadAttempts >= MAX_DOWNLOAD_ATTEMPTS) {
    return null
  }

  const message = toInboundMessage(row)
  try {
    const media = await provider.downloadAttachment(message, row.externalId)
    await markAttachmentDownloaded(db, row.messageId, row.externalId, media.localPath, media.sizeBytes)
    return media.localPath
  } catch (error) {
    const detail = describeError(error)
    await markAttachmentFailed(db, row.messageId, row.externalId, detail)
    log.warn('could not download an attachment for enrichment', {
      externalId: row.externalId,
      error: detail,
    })
    return null
  }
}

async function enrichOne(
  db: Db,
  provider: MessagingProvider,
  media: MediaModel,
  row: EnrichAttachment,
  preferredLanguage: string | null,
  log: Logger,
): Promise<void> {
  const kind = derivationKindFor(row.kind)
  if (!kind) return

  const model = derivationModelFor(media, kind)
  const existing = await getDerivation(db, row.id, kind, model)
  if (existing !== null) return

  const localPath = await ensureDownloaded(db, provider, row, log)
  if (!localPath) return

  try {
    const text =
      kind === 'transcript'
        ? await media.transcribe(localPath, row.mimeType, { preferredLanguage })
        : await media.describe(localPath, row.mimeType)
    if (kind === 'transcript' && text.trim() === '') {
      log.warn('empty transcript, skipping derivation', { attachmentId: row.id })
      return
    }
    await upsertDerivation(db, {
      attachmentId: row.id,
      kind,
      model,
      text,
    })
  } catch (error) {
    log.warn('media enrichment failed', {
      attachmentId: row.id,
      kind,
      error: describeError(error),
    })
  }
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return
  const queue = [...items]
  const n = Math.min(concurrency, queue.length)
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (queue.length > 0) {
        const item = queue.shift()
        if (!item) return
        await worker(item)
      }
    }),
  )
}

/**
 * Lazily derives transcripts/descriptions for audio and image attachments
 * in `[from, to)`. Skips cached rows; retries failed downloads when attempts
 * remain; swallows model errors so a partial summary still ships.
 */
export async function enrichRange(
  db: Db,
  provider: MessagingProvider,
  media: MediaModel,
  conversationId: string,
  from: Date,
  to: Date,
  log: Logger = silentLogger,
): Promise<void> {
  const rows = await listEnrichableAttachments(db, conversationId, from, to)
  const messageTexts = await loadMessageTextsForPrior(db, conversationId, from, to)
  const preferredLanguage = inferChatLanguagePrior(messageTexts)
  await runPool(rows, ENRICH_CONCURRENCY, (row) =>
    enrichOne(db, provider, media, row, preferredLanguage, log),
  )
}
