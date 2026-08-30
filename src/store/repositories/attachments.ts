import type { InboundAttachment } from '../../domain/types.ts'
import type { Db } from '../client.ts'
import { attachments } from '../schema.ts'

export async function insertAttachments(
  db: Db,
  messageId: string,
  items: readonly InboundAttachment[],
): Promise<void> {
  if (items.length === 0) return

  await db
    .insert(attachments)
    .values(
      items.map((item) => ({
        messageId,
        externalId: item.externalId,
        kind: item.kind,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        durationMs: item.durationMs,
      })),
    )
    .onConflictDoNothing({ target: [attachments.messageId, attachments.externalId] })
}
