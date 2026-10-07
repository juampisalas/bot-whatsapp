import type { Logger } from '../domain/logger.ts'
import { describeError, silentLogger } from '../domain/logger.ts'
import type { MessagingProvider } from '../domain/provider.ts'
import type { InboundMessage } from '../domain/types.ts'
import type { Db } from '../store/client.ts'
import { insertAttachments } from '../store/repositories/attachments.ts'
import {
  upsertConversation,
  upsertParticipant,
  syncPushName,
} from '../store/repositories/conversations.ts'
import { encodeRaw } from '../store/raw.ts'
import { insertMessage } from '../store/repositories/messages.ts'
import { BoundedBuffer } from './buffer.ts'
import { createMediaDownloader } from './media.ts'
import { shouldCapture, type CapturePolicy } from './policy.ts'

export interface IngestDeps {
  db: Db
  provider: MessagingProvider
  policy: CapturePolicy
  bufferMax: number
  log?: Logger
}

export function createIngestPipeline(deps: IngestDeps) {
  const log = deps.log ?? silentLogger
  const buffer = new BoundedBuffer<InboundMessage>(deps.bufferMax)
  const downloadPendingAttachments = createMediaDownloader({
    db: deps.db,
    provider: deps.provider,
    log,
  })

  async function persist(message: InboundMessage): Promise<boolean> {
    const conversationId = await upsertConversation(deps.db, {
      provider: message.provider,
      externalId: message.conversation.externalId,
      kind: message.conversation.kind,
      name: message.conversation.name,
    })

    const participantId = message.sender
      ? await upsertParticipant(deps.db, {
          provider: message.provider,
          externalId: message.sender.externalId,
          displayName: message.sender.displayName,
        })
      : null

    if (message.conversation.kind === 'dm') {
      const pushName = message.sender?.displayName ?? null
      if (pushName) {
        await syncPushName(deps.db, message.provider, {
          externalIds: [message.conversation.externalId, message.sender?.externalId].filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          ),
          name: pushName,
        })
      }
    }

    const { id, inserted } = await insertMessage(deps.db, {
      provider: message.provider,
      externalId: message.externalId,
      conversationId,
      participantId,
      sentAt: message.sentAt,
      fromSelf: message.fromSelf,
      text: message.text,
      subject: message.subject,
      threadExternalId: message.threadExternalId,
      replyToExternalId: message.replyToExternalId,
      raw: encodeRaw(message.raw),
    })

    // Conditional upsert fills null metadata on redelivery without clobbering known values.
    await insertAttachments(deps.db, id, message.attachments)
    await downloadPendingAttachments(message, id)
    return inserted
  }

  async function handle(message: InboundMessage): Promise<{ inserted: boolean } | undefined> {
    if (!shouldCapture(deps.policy, message.conversation.externalId)) return undefined

    try {
      const inserted = await persist(message)
      return { inserted }
    } catch (error) {
      buffer.push(message)
      log.warn('could not persist, message buffered', {
        externalId: message.externalId,
        buffered: buffer.size,
        dropped: buffer.dropped,
        error: describeError(error),
      })
    }
  }

  async function drain(): Promise<number> {
    const pending = buffer.drain()
    const failed: InboundMessage[] = []
    let persisted = 0

    for (const message of pending) {
      try {
        await persist(message)
        persisted += 1
      } catch {
        failed.push(message)
      }
    }

    const droppedBefore = buffer.dropped
    buffer.requeueFront(failed)
    if (buffer.dropped > droppedBefore) {
      log.warn('buffer dropped messages while retrying', {
        buffered: buffer.size,
        dropped: buffer.dropped,
      })
    }
    if (persisted > 0) log.info('buffer flushed', { persisted })
    return persisted
  }

  // `drain` starts by emptying the buffer, so while a run is in flight `bufferSize` lies:
  // what that run fails to persist only returns on requeue. Waiting on the in-flight drain
  // instead of starting another one moves the `bufferSize` read to after that requeue,
  // which is the only moment it reflects what truly remains unpersisted.
  let inFlight: Promise<number> | null = null

  /** Retries what is queued and keeps for another attempt whatever still fails. */
  function flushBuffer(): Promise<number> {
    inFlight ??= drain().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  return {
    handle,
    flushBuffer,
    /** Still unpersisted: shutdown reports this as loss. */
    get bufferSize(): number {
      return buffer.size
    },
  }
}
