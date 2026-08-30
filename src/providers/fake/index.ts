import type { InboundHandler, MessagingProvider } from '../../domain/provider.ts'
import type {
  ConversationRef,
  ConversationSummary,
  DownloadedMedia,
  InboundMessage,
  OutboundContent,
  ProviderId,
  SentMessage,
} from '../../domain/types.ts'

export interface SentRecord {
  target: ConversationRef
  content: OutboundContent
  idempotencyKey: string
}

export class FakeProvider implements MessagingProvider {
  readonly id: ProviderId = 'fake'

  private handler: InboundHandler | null = null
  private connected = false
  private nextSendError: Error | null = null
  private readonly sentRecords: SentRecord[] = []
  private readonly conversations: ConversationSummary[] = []

  get sent(): readonly SentRecord[] {
    return this.sentRecords
  }

  async connect(): Promise<void> {
    this.connected = true
  }

  async waitUntilReady(): Promise<void> {
    if (!this.connected) throw new Error('FakeProvider sin conectar')
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  onMessage(handler: InboundHandler): void {
    this.handler = handler
  }

  /** Simula la llegada de un mensaje desde el canal. */
  async inject(message: InboundMessage): Promise<void> {
    if (!this.connected) throw new Error('FakeProvider sin conectar')
    if (!this.handler) throw new Error('FakeProvider sin manejador registrado')
    await this.handler(message)
  }

  /** Hace fallar el próximo envío, una única vez. */
  failNextSend(error: Error): void {
    this.nextSendError = error
  }

  /** Registra conversaciones que devolverá `listConversations`. */
  seedConversations(items: ConversationSummary[]): void {
    this.conversations.splice(0, this.conversations.length, ...items)
  }

  async send(
    target: ConversationRef,
    content: OutboundContent,
    idempotencyKey: string,
  ): Promise<SentMessage> {
    if (this.nextSendError) {
      const error = this.nextSendError
      this.nextSendError = null
      throw error
    }
    this.sentRecords.push({ target, content, idempotencyKey })
    return { externalId: idempotencyKey }
  }

  async downloadAttachment(
    _message: InboundMessage,
    attachmentExternalId: string,
  ): Promise<DownloadedMedia> {
    return { localPath: `/tmp/fake/${attachmentExternalId}`, sizeBytes: 0 }
  }

  async listConversations(): Promise<ConversationSummary[]> {
    return [...this.conversations]
  }
}
