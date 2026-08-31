import type {
  ConversationMetaHandler,
  FatalHandler,
  InboundHandler,
  MessagingProvider,
} from '../../domain/provider.ts'
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

export interface DownloadBarrier {
  entered: Promise<void>
  release(): void
}

export class FakeProvider implements MessagingProvider {
  readonly id: ProviderId = 'fake'

  private handler: InboundHandler | null = null
  private fatalHandler: FatalHandler | null = null
  private conversationMetaHandler: ConversationMetaHandler | null = null
  private connected = false
  private nextSendError: Error | null = null
  private readonly downloadErrors: Error[] = []
  private downloadBarrier: { wait: Promise<void>; signalEntered: () => void } | null = null
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
    if (!this.connected) throw new Error('FakeProvider is not connected')
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  onMessage(handler: InboundHandler): void {
    this.handler = handler
  }

  onFatal(handler: FatalHandler): void {
    this.fatalHandler = handler
  }

  onConversationMeta(handler: ConversationMetaHandler): void {
    this.conversationMetaHandler = handler
  }

  // Test-only helpers: not part of MessagingProvider; do not call from production.
  async inject(message: InboundMessage): Promise<void> {
    if (!this.connected) throw new Error('FakeProvider is not connected')
    if (!this.handler) throw new Error('FakeProvider has no message handler registered')
    await this.handler(message)
  }

  /** Fires the fatal channel without needing a real broken session. */
  emitFatal(error: Error): void {
    this.fatalHandler?.(error)
  }

  /** Test-only: publish conversation metadata the same way WhatsApp would. */
  async emitConversationMeta(
    conversation: Parameters<ConversationMetaHandler>[0],
  ): Promise<void> {
    await this.conversationMetaHandler?.(conversation)
  }

  failNextSend(error: Error): void {
    this.nextSendError = error
  }

  failNextDownload(error: Error): void {
    this.downloadErrors.push(error)
  }

  // Test-only: keeps overlapping downloads without depending on scheduler delays.
  blockDownloads(): DownloadBarrier {
    let signalEntered = (): void => {}
    let releaseWait = (): void => {}
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve
    })
    const wait = new Promise<void>((resolve) => {
      releaseWait = resolve
    })
    this.downloadBarrier = { wait, signalEntered }
    return {
      entered,
      release: () => {
        this.downloadBarrier = null
        releaseWait()
      },
    }
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
    const barrier = this.downloadBarrier
    barrier?.signalEntered()
    await barrier?.wait
    const error = this.downloadErrors.shift()
    if (error) {
      throw error
    }
    return { localPath: `/tmp/fake/${attachmentExternalId}`, sizeBytes: 4096 }
  }

  async listConversations(): Promise<ConversationSummary[]> {
    return [...this.conversations]
  }
}
