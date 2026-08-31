import type { Logger } from '../domain/logger.ts'
import { silentLogger } from '../domain/logger.ts'
import type { MessagingProvider } from '../domain/provider.ts'
import type { InboundMessage } from '../domain/types.ts'
import type { Db } from '../store/client.ts'
import { insertAttachments } from '../store/repositories/attachments.ts'
import {
  upsertConversation,
  upsertParticipant,
} from '../store/repositories/conversations.ts'
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

    const { id } = await insertMessage(deps.db, {
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

    // La escritura idempotente incondicional repara metadatos faltantes tras un commit parcial o una reentrega.
    await insertAttachments(deps.db, id, message.attachments)
    await downloadPendingAttachments(message, id)
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

  async function vaciar(): Promise<number> {
    const pendientes = buffer.drain()
    const fallidos: InboundMessage[] = []
    let persistidos = 0

    for (const message of pendientes) {
      try {
        await persist(message)
        persistidos += 1
      } catch {
        fallidos.push(message)
      }
    }

    const descartadosAntes = buffer.dropped
    buffer.requeueFront(fallidos)
    if (buffer.dropped > descartadosAntes) {
      log.warn('buffer descartó mensajes al reintentar', {
        enBuffer: buffer.size,
        descartados: buffer.dropped,
      })
    }
    if (persistidos > 0) log.info('buffer vaciado', { persistidos })
    return persistidos
  }

  // `vaciar` arranca drenando el buffer, así que mientras una corrida está en vuelo el
  // buffer está vacío y `bufferSize` no dice la verdad: lo que esa corrida no logre
  // persistir vuelve recién al reencolar. Esperar al vaciado en vuelo en vez de arrancar
  // otro corre la lectura de `bufferSize` hasta después de ese reencolado, que es el
  // único momento en que refleja lo que de verdad quedó sin persistir.
  let enVuelo: Promise<number> | null = null

  /** Reintenta lo acumulado y conserva para otro intento lo que aún falla. */
  function flushBuffer(): Promise<number> {
    enVuelo ??= vaciar().finally(() => {
      enVuelo = null
    })
    return enVuelo
  }

  return {
    handle,
    flushBuffer,
    /** Lo que todavía no se pudo persistir: el apagado lo reporta como pérdida. */
    get bufferSize(): number {
      return buffer.size
    },
  }
}
