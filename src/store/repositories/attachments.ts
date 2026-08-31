import { and, eq, lt, ne, sql } from 'drizzle-orm'
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

export async function listAttachmentsToDownload(
  db: Db,
  messageId: string,
  maxAttempts: number,
): Promise<{ externalId: string }[]> {
  return db
    .select({ externalId: attachments.externalId })
    .from(attachments)
    .where(
      and(
        eq(attachments.messageId, messageId),
        ne(attachments.downloadStatus, 'ok'),
        lt(attachments.downloadAttempts, maxAttempts),
      ),
    )
}

export async function markAttachmentDownloaded(
  db: Db,
  messageId: string,
  externalId: string,
  localPath: string,
  sizeBytes: number,
): Promise<void> {
  await db
    .update(attachments)
    .set({ downloadStatus: 'ok', localPath, sizeBytes, downloadError: null })
    .where(and(eq(attachments.messageId, messageId), eq(attachments.externalId, externalId)))
}

export async function markAttachmentFailed(
  db: Db,
  messageId: string,
  externalId: string,
  error: string,
): Promise<void> {
  await db
    .update(attachments)
    .set({
      downloadStatus: 'failed',
      downloadError: error,
      downloadAttempts: sql`${attachments.downloadAttempts} + 1`,
    })
    .where(and(eq(attachments.messageId, messageId), eq(attachments.externalId, externalId)))
}
