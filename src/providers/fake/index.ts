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

export interface DownloadRecord {
  messageExternalId: string
  attachmentExternalId: string
}

export class FakeProvider implements MessagingProvider {
  readonly id: ProviderId = 'fake'

  private handler: InboundHandler | null = null
  private connected = false
  private nextSendError: Error | null = null
  private nextDownloadError: Error | null = null
  private readonly sentRecords: SentRecord[] = []
  private readonly downloadRecords: DownloadRecord[] = []
  private readonly conversations: ConversationSummary[] = []

  get sent(): readonly SentRecord[] {
    return this.sentRecords
  }

  get downloads(): readonly DownloadRecord[] {
    return this.downloadRecords
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

  // Solo para tests: no forman parte del puerto MessagingProvider; no invocar desde producción.
  async inject(message: InboundMessage): Promise<void> {
    if (!this.connected) throw new Error('FakeProvider sin conectar')
    if (!this.handler) throw new Error('FakeProvider sin manejador registrado')
    await this.handler(message)
  }

  failNextSend(error: Error): void {
    this.nextSendError = error
  }

  failNextDownload(error: Error): void {
    this.nextDownloadError = error
  }

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
    message: InboundMessage,
    attachmentExternalId: string,
  ): Promise<DownloadedMedia> {
    this.downloadRecords.push({ messageExternalId: message.externalId, attachmentExternalId })
    if (this.nextDownloadError) {
      const error = this.nextDownloadError
      this.nextDownloadError = null
      throw error
    }
    return { localPath: `/tmp/fake/${attachmentExternalId}`, sizeBytes: 4096 }
  }

  async listConversations(): Promise<ConversationSummary[]> {
    return [...this.conversations]
  }
}
