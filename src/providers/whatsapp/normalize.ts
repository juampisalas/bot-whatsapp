import { normalizeMessageContent } from 'baileys'
import type { WAMessage, proto } from 'baileys'
import type {
  AttachmentKind,
  ConversationKind,
  InboundAttachment,
  InboundMessage,
} from '../../domain/types.ts'

/**
 * Null para lo que llega por el mismo evento que los mensajes pero no es una conversación.
 *
 * Los estados (`status@broadcast`) entran por `messages.upsert` como un chat más: con el
 * history sync completo, esa única fila acumularía las historias de todos los contactos y
 * el resumen se la ofrecería al usuario como si fuera alguien con quien habla.
 *
 * Las listas de difusión (`<id>@broadcast`) traen contenido real —son mensajes que mandó
 * la cuenta vinculada—, pero tampoco son un chat: no hay interlocutor y las respuestas
 * vuelven como mensajes uno a uno, así que no hay diálogo que resumir. Se descartan a
 * sabiendas de que se pierde esa copia; la conversación con cada destinatario sí se
 * captura por su lado.
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
  // pushName identifies the author, so it names a conversation only when that author is the DM contact.
  const conversationName =
    kind === 'dm' && !fromSelf ? (waMessage.pushName ?? null) : null

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
    replyToExternalId: replyToExternalId(content),
    attachments,
    raw: waMessage,
  }
}
