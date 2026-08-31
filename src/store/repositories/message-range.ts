import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm'
import type { AttachmentKind } from '../../domain/types.ts'
import type { Db } from '../client.ts'
import { attachments, messages, participants } from '../schema.ts'

export type RangeMessage = {
  id: string
  sentAt: Date
  senderName: string
  text: string | null
}

export type RangeAttachment = {
  messageId: string
  kind: AttachmentKind
  durationMs: number | null
}

export type MessagesInRange = {
  messages: RangeMessage[]
  attachments: RangeAttachment[]
  messageCount: number
  lastMessageAt: Date | null
}

/**
 * Loads messages in `[from, to)` for a conversation, with sender names and
 * attachment markers needed by `renderTranscript`.
 */
export async function listMessagesInRange(
  db: Db,
  conversationId: string,
  from: Date,
  to: Date,
): Promise<MessagesInRange> {
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
      ),
    )
    .orderBy(asc(messages.sentAt))

  const rangeMessages: RangeMessage[] = rows.map((row) => ({
    id: row.id,
    sentAt: row.sentAt,
    senderName: row.displayName ?? (row.fromSelf ? 'You' : 'Unknown'),
    text: row.text,
  }))

  const messageIds = rangeMessages.map((message) => message.id)
  const attachmentRows =
    messageIds.length === 0
      ? []
      : await db
          .select({
            messageId: attachments.messageId,
            kind: attachments.kind,
            durationMs: attachments.durationMs,
          })
          .from(attachments)
          .where(inArray(attachments.messageId, messageIds))

  const rangeAttachments: RangeAttachment[] = attachmentRows.map((row) => ({
    messageId: row.messageId,
    kind: row.kind,
    durationMs: row.durationMs,
  }))

  const lastMessageAt =
    rangeMessages.length === 0 ? null : rangeMessages[rangeMessages.length - 1]!.sentAt

  return {
    messages: rangeMessages,
    attachments: rangeAttachments,
    messageCount: rangeMessages.length,
    lastMessageAt,
  }
}
