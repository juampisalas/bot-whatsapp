import type { Logger } from '../domain/logger.ts'
import { silentLogger } from '../domain/logger.ts'
import type { InboundMessage } from '../domain/types.ts'
import type { Db } from '../store/client.ts'
import { insertAttachments } from '../store/repositories/attachments.ts'
import {
  upsertConversation,
  upsertParticipant,
} from '../store/repositories/conversations.ts'
import { insertMessage } from '../store/repositories/messages.ts'
import { BoundedBuffer } from './buffer.ts'
import { shouldCapture, type CapturePolicy } from './policy.ts'

export interface IngestDeps {
  db: Db
  policy: CapturePolicy
  bufferMax: number
  log?: Logger
}

export function createIngestPipeline(deps: IngestDeps) {
  const log = deps.log ?? silentLogger
  const buffer = new BoundedBuffer<InboundMessage>(deps.bufferMax)

  async function persist(message: InboundMessage): Promise<void> {
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
      raw: message.raw,
    })

    if (inserted) {
      await insertAttachments(deps.db, id, message.attachments)
    }
  }

  async function handle(message: InboundMessage): Promise<void> {
    if (!shouldCapture(deps.policy, message.conversation.externalId)) return

    try {
      await persist(message)
    } catch (error) {
      buffer.push(message)
      log.warn('no se pudo persistir, mensaje en buffer', {
        externalId: message.externalId,
        enBuffer: buffer.size,
        descartados: buffer.dropped,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Reintenta lo acumulado y conserva para otro intento lo que aún falla. */
  async function flushBuffer(): Promise<number> {
    const pendientes = buffer.drain()
    let persistidos = 0

    for (const message of pendientes) {
      try {
        await persist(message)
        persistidos += 1
      } catch {
        buffer.push(message)
      }
    }

    if (persistidos > 0) log.info('buffer vaciado', { persistidos })
    return persistidos
  }

  return { handle, flushBuffer }
}
