import type { Logger } from '../domain/logger.ts'
import type { MessagingProvider } from '../domain/provider.ts'
import type { InboundMessage } from '../domain/types.ts'
import type { Db } from '../store/client.ts'
import {
  listAttachmentsToDownload,
  markAttachmentDownloaded,
  markAttachmentFailed,
} from '../store/repositories/attachments.ts'

export interface MediaDeps {
  db: Db
  provider: MessagingProvider
  log?: Logger
}

/**
 * El medio de WhatsApp expira; el tope evita reintentos perpetuos
 * durante las reentregas de mensajes históricos.
 */
export const MAX_DOWNLOAD_ATTEMPTS = 3

export async function downloadPendingAttachments(
  deps: MediaDeps,
  message: InboundMessage,
  messageId: string,
): Promise<void> {
  const pending = await listAttachmentsToDownload(deps.db, messageId, MAX_DOWNLOAD_ATTEMPTS)

  for (const { externalId } of pending) {
    try {
      const media = await deps.provider.downloadAttachment(message, externalId)
      await markAttachmentDownloaded(deps.db, messageId, externalId, media.localPath, media.sizeBytes)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await markAttachmentFailed(deps.db, messageId, externalId, detail)
      deps.log?.warn('no se pudo descargar un adjunto', { externalId, error: detail })
    }
  }
}
