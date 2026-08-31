import { describeError, type Logger } from '../domain/logger.ts'
import type { MessagingProvider } from '../domain/provider.ts'
import type { DownloadedMedia, InboundMessage } from '../domain/types.ts'
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
 * WhatsApp media expires; the cap avoids perpetual retries during historical redeliveries.
 */
export const MAX_DOWNLOAD_ATTEMPTS = 3

export function createMediaDownloader(deps: MediaDeps) {
  const inFlight = new Map<string, Promise<void>>()

  async function downloadOne(
    message: InboundMessage,
    messageId: string,
    externalId: string,
  ): Promise<void> {
    const eligible = await listAttachmentsToDownload(deps.db, messageId, MAX_DOWNLOAD_ATTEMPTS)
    if (!eligible.some((attachment) => attachment.externalId === externalId)) return

    let media: DownloadedMedia
    try {
      media = await deps.provider.downloadAttachment(message, externalId)
    } catch (error) {
      // Detail is persisted on the attachment row: that is all that remains to explain a
      // failed download, so it must include the wrapped cause.
      const detail = describeError(error)
      await markAttachmentFailed(deps.db, messageId, externalId, detail)
      deps.log?.warn('could not download an attachment', { externalId, error: detail })
      return
    }
    await markAttachmentDownloaded(deps.db, messageId, externalId, media.localPath, media.sizeBytes)
  }

  function downloadSingleFlight(
    message: InboundMessage,
    messageId: string,
    externalId: string,
  ): Promise<void> {
    const key = `${messageId}\0${externalId}`
    const existing = inFlight.get(key)
    if (existing) return existing

    const operation = downloadOne(message, messageId, externalId).finally(() => {
      if (inFlight.get(key) === operation) inFlight.delete(key)
    })
    inFlight.set(key, operation)
    return operation
  }

  return async function downloadPendingAttachments(
    message: InboundMessage,
    messageId: string,
  ): Promise<void> {
    await Promise.all(
      message.attachments.map(({ externalId }) =>
        downloadSingleFlight(message, messageId, externalId),
      ),
    )
  }
}
