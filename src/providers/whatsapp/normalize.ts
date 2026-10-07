import { normalizeMessageContent } from 'baileys'
import type { WAMessage, proto } from 'baileys'
import type {
  AttachmentKind,
  ConversationKind,
  InboundAttachment,
  InboundMessage,
} from '../../domain/types.ts'

/**
 * Null for payloads that arrive on the same event as messages but are not a conversation.
 *
 * Status broadcasts (`status@broadcast`) show up on `messages.upsert` like any other chat:
 * with full history sync that single row would accumulate every contact's stories and the
 * summarizer would offer it as someone the user talks to.
 *
 * Broadcast lists (`<id>@broadcast`) carry real content — messages the linked account sent —
 * but they are not a chat either: there is no interlocutor and replies come back as DMs, so
 * there is no dialogue to summarize. They are dropped on purpose; each recipient conversation
 * is still captured on its own side.
 */
function conversationKind(remoteJid: string): ConversationKind | null {
  if (remoteJid.endsWith('@g.us')) return 'group'
  if (remoteJid.endsWith('@newsletter')) return 'channel'
  if (remoteJid.endsWith('@broadcast')) return null
  return 'dm'
}

interface MediaSpec {
  kind: AttachmentKind
  mimeType: string | null
  sizeBytes: number | null
  durationMs: number | null
  caption: string | null
}

function mediaSpec(content: proto.IMessage): MediaSpec | null {
  // Protobuf delivers `fileLength` as number or Long; `Number()` covers both.
  const toBytes = (value: unknown): number | null => {
    if (value === null || value === undefined) return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  if (content.audioMessage) {
    const message = content.audioMessage
    return {
      kind: 'audio',
      mimeType: message.mimetype ?? null,
      sizeBytes: toBytes(message.fileLength),
      durationMs: message.seconds ? message.seconds * 1000 : null,
      caption: null,
    }
  }

  if (content.imageMessage) {
    const message = content.imageMessage
    return {
      kind: 'image',
      mimeType: message.mimetype ?? null,
      sizeBytes: toBytes(message.fileLength),
      durationMs: null,
      caption: message.caption ?? null,
    }
  }

  const videoMessage = content.videoMessage ?? content.ptvMessage
  if (videoMessage) {
    return {
      kind: 'video',
      mimeType: videoMessage.mimetype ?? null,
      sizeBytes: toBytes(videoMessage.fileLength),
      durationMs: videoMessage.seconds ? videoMessage.seconds * 1000 : null,
      caption: videoMessage.caption ?? null,
    }
  }

  if (content.documentMessage) {
    const message = content.documentMessage
    return {
      kind: 'document',
      mimeType: message.mimetype ?? null,
      sizeBytes: toBytes(message.fileLength),
      durationMs: null,
      caption: message.caption ?? null,
    }
  }

  if (content.stickerMessage) {
    const message = content.stickerMessage
    return {
      kind: 'sticker',
      mimeType: message.mimetype ?? null,
      sizeBytes: toBytes(message.fileLength),
      durationMs: null,
      caption: null,
    }
  }

  return null
}

function plainText(content: proto.IMessage): string | null {
  return content.conversation ?? content.extendedTextMessage?.text ?? null
}

const NORMALIZED_CONTEXT_NODES = [
  'extendedTextMessage',
  'imageMessage',
  'audioMessage',
  'videoMessage',
  'ptvMessage',
  'documentMessage',
  'stickerMessage',
] as const satisfies readonly (keyof proto.IMessage)[]

function replyToExternalId(content: proto.IMessage, remoteJid: string): string | null {
  for (const key of NORMALIZED_CONTEXT_NODES) {
    const stanzaId = content[key]?.contextInfo?.stanzaId
    // Same scoping as message external ids: WhatsApp ids are unique per chat, not globally.
    if (stanzaId) return `${remoteJid}:${stanzaId}`
  }

  return null
}

export interface NormalizeOptions {
  /** Subject/name known for a group from Baileys group metadata. */
  groupName?: string | null
}

/**
 * WhatsApp message ids are unique within a chat, not across chats. Persisting
 * `key.id` alone under a global unique index would collide across conversations
 * and silently drop the second message while attaching media to the wrong row.
 * Qualifying with `remoteJid` keeps the store identity aligned with that rule.
 */
export function normalizeWAMessage(
  waMessage: WAMessage,
  selfJid: string,
  options: NormalizeOptions = {},
): InboundMessage | null {
  const remoteJid = waMessage.key?.remoteJid
  const messageId = waMessage.key?.id
  if (!remoteJid || !messageId) return null

  const kind = conversationKind(remoteJid)
  if (!kind) return null

  const timestampValue = waMessage.messageTimestamp
  if (timestampValue === null || timestampValue === undefined) return null

  const timestamp = Number(timestampValue)
  if (!Number.isFinite(timestamp)) return null

  const content = normalizeMessageContent(waMessage.message)
  if (!content) return null

  const media = mediaSpec(content)
  const text = plainText(content) ?? media?.caption ?? null
  if (text === null && !media) return null

  const fromSelf = waMessage.key?.fromMe === true
  const senderJid = fromSelf
    ? selfJid
    : kind === 'group'
      ? (waMessage.key?.participant ?? null)
      : remoteJid
  // DMs take their display label from address book / phone / push name sync, not inline here.
  const conversationName = kind === 'group' ? (options.groupName ?? null) : null

  const externalId = `${remoteJid}:${messageId}`

  const attachments: InboundAttachment[] = media
    ? [
        {
          externalId: `${externalId}:0`,
          kind: media.kind,
          mimeType: media.mimeType,
          sizeBytes: media.sizeBytes,
          durationMs: media.durationMs,
        },
      ]
    : []

  return {
    provider: 'whatsapp',
    externalId,
    conversation: {
      externalId: remoteJid,
      kind,
      name: conversationName,
    },
    sender: senderJid
      ? { externalId: senderJid, displayName: fromSelf ? null : (waMessage.pushName ?? null) }
      : null,
    sentAt: new Date(timestamp * 1000),
    fromSelf,
    text,
    subject: null,
    threadExternalId: null,
    replyToExternalId: replyToExternalId(content, remoteJid),
    attachments,
    raw: waMessage,
  }
}
