export type ProviderId = 'whatsapp' | 'telegram' | 'slack' | 'gmail' | 'fake'

export type ConversationKind = 'dm' | 'group' | 'channel' | 'thread'

export type AttachmentKind = 'image' | 'audio' | 'video' | 'document' | 'sticker'

/** Modo de la política de captura. */
export type CaptureMode = 'all' | 'whitelist' | 'blacklist'

/** Estado de la descarga de los bytes de un adjunto. */
export type DownloadStatus = 'pending' | 'ok' | 'failed'

/** Status of an outbound queue row. */
export type OutboundStatus = 'pending' | 'sending' | 'sent' | 'failed'

export interface ConversationRef {
  provider: ProviderId
  externalId: string
}

export interface InboundAttachment {
  externalId: string
  kind: AttachmentKind
  mimeType: string | null
  sizeBytes: number | null
  durationMs: number | null
}

export interface InboundMessage {
  provider: ProviderId
  externalId: string
  conversation: {
    externalId: string
    kind: ConversationKind
    name: string | null
  }
  sender: {
    externalId: string
    displayName: string | null
  } | null
  sentAt: Date
  fromSelf: boolean
  text: string | null
  /** Solo para canales de correo. Null en mensajería instantánea. */
  subject: string | null
  /** Solo para canales de correo. Null en mensajería instantánea. */
  threadExternalId: string | null
  replyToExternalId: string | null
  /**
   * True for history sync and offline backlog. Those messages are stored, but the
   * control loop must not answer them: a reconnect would otherwise replay old commands.
   */
  historical?: boolean
  attachments: InboundAttachment[]
  /**
   * Carga original del proveedor. Únicamente el adaptador que la produjo
   * puede interpretarla; el resto del sistema solo la persiste y la devuelve.
   */
  raw: unknown
}

export interface OutboundContent {
  text: string
}

export interface SentMessage {
  externalId: string
}

export interface ConversationSummary {
  externalId: string
  kind: ConversationKind
  name: string | null
  participantCount: number | null
}

export interface DownloadedMedia {
  localPath: string
  sizeBytes: number
}
