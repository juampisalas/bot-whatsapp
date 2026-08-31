import type {
  ConversationKind,
  ConversationRef,
  ConversationSummary,
  DownloadedMedia,
  InboundMessage,
  OutboundContent,
  ProviderId,
  SentMessage,
} from './types.ts'

export type InboundHandler = (message: InboundMessage) => Promise<void>

export type FatalHandler = (error: Error) => void

export interface ConversationMeta {
  externalId: string
  kind: ConversationKind
  name: string | null
}

export type ConversationMetaHandler = (conversation: ConversationMeta) => Promise<void>

export interface MessagingProvider {
  readonly id: ProviderId

  /**
   * Establishes the connection. Does not assume realtime: an adapter that
   * internally polls still satisfies the contract.
   */
  connect(): Promise<void>

  /**
   * Resolves when the channel is ready to operate. Exists because `connect`
   * only starts the process: on WhatsApp the user may need to scan a QR before
   * there is a usable session. Rejects if the wait times out or the session
   * was closed.
   */
  waitUntilReady(timeoutMs?: number): Promise<void>

  disconnect(): Promise<void>

  /** Registers the inbound message handler. */
  onMessage(handler: InboundHandler): void

  /**
   * Registers notice that the channel is unusable and will not recover on its own:
   * intervention is required, typically re-linking. Exists because such a failure can
   * arrive long after connect, once `waitUntilReady` already resolved and nobody is
   * watching; without this channel the process stays up capturing nothing and unable
   * to report it.
   */
  onFatal(handler: FatalHandler): void

  /**
   * Optional: conversation metadata updates (e.g. group subject changes) that are
   * not carried on individual messages.
   */
  onConversationMeta?(handler: ConversationMetaHandler): void

  /**
   * Sends a message. `idempotencyKey` is used as the message id when the channel
   * allows it, so a retry does not produce a duplicate.
   */
  send(
    target: ConversationRef,
    content: OutboundContent,
    idempotencyKey: string,
  ): Promise<SentMessage>

  /** Downloads an attachment from an already-received message. */
  downloadAttachment(message: InboundMessage, attachmentExternalId: string): Promise<DownloadedMedia>

  listConversations(): Promise<ConversationSummary[]>
}
