import type { MessageWithContextInfo, WAMessage, proto } from 'baileys'
import type {
  AttachmentKind,
  ConversationKind,
  InboundAttachment,
  InboundMessage,
} from '../../domain/types.ts'

function unwrap(content: proto.IMessage | null | undefined): proto.IMessage | null {
  let current = content ?? null

  // Wrappers can be composed; the depth cap prevents malformed payloads from looping indefinitely.
  for (let depth = 0; current && depth < 4; depth += 1) {
    const inner =
      current.ephemeralMessage?.message ??
      current.viewOnceMessage?.message ??
      current.viewOnceMessageV2?.message ??
      current.documentWithCaptionMessage?.message ??
      null

    if (!inner) return current
    current = inner
  }

  return current
}

function conversationKind(remoteJid: string): ConversationKind {
  if (remoteJid.endsWith('@g.us')) return 'group'
  if (remoteJid.endsWith('@newsletter')) return 'channel'
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
  // Protobuf exposes fileLength as either a number or Long; Number() handles both representations.
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

  if (content.videoMessage) {
    const message = content.videoMessage
    return {
      kind: 'video',
      mimeType: message.mimetype ?? null,
      sizeBytes: toBytes(message.fileLength),
      durationMs: message.seconds ? message.seconds * 1000 : null,
      caption: message.caption ?? null,
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
  'documentMessage',
  'stickerMessage',
] as const satisfies readonly MessageWithContextInfo[]

function replyToExternalId(content: proto.IMessage): string | null {
  for (const key of NORMALIZED_CONTEXT_NODES) {
    const stanzaId = content[key]?.contextInfo?.stanzaId
    if (stanzaId) return stanzaId
  }

  return null
}

export function normalizeWAMessage(
  waMessage: WAMessage,
  selfJid: string,
): InboundMessage | null {
  const remoteJid = waMessage.key?.remoteJid
  const externalId = waMessage.key?.id
  if (!remoteJid || !externalId) return null

  const content = unwrap(waMessage.message)
  if (!content) return null

  const media = mediaSpec(content)
  const text = plainText(content) ?? media?.caption ?? null
  if (text === null && !media) return null

  const fromSelf = waMessage.key?.fromMe === true
  const kind = conversationKind(remoteJid)
  const senderJid = fromSelf
    ? selfJid
    : kind === 'group'
      ? (waMessage.key?.participant ?? null)
      : remoteJid

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

  const timestamp = Number(waMessage.messageTimestamp ?? 0)

  return {
    provider: 'whatsapp',
    externalId,
    conversation: {
      externalId: remoteJid,
      kind,
      name: kind === 'group' ? null : (waMessage.pushName ?? null),
    },
    sender: senderJid
      ? { externalId: senderJid, displayName: fromSelf ? null : (waMessage.pushName ?? null) }
      : null,
    sentAt: new Date(timestamp * 1000),
    fromSelf,
    text,
    subject: null,
    threadExternalId: null,
    replyToExternalId: replyToExternalId(content),
    attachments,
    raw: waMessage,
  }
}
