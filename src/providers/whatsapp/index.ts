import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from 'baileys'
import qrcode from 'qrcode-terminal'
import { silentLogger, type Logger } from '../../domain/logger.ts'
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
import { normalizeWAMessage } from './normalize.ts'

export interface WhatsAppProviderOptions {
  authDir: string
  mediaDir: string
  log?: Logger
}

interface ReadyWaiter {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class WhatsAppProvider implements MessagingProvider {
  readonly id: ProviderId = 'whatsapp'

  private socket: WASocket | null = null
  private handler: InboundHandler | null = null
  private closing = false
  private reconnectDelayMs = 1_000
  private open = false
  private readonly readyWaiters: ReadyWaiter[] = []

  constructor(private readonly options: WhatsAppProviderOptions) {}

  private get log(): Logger {
    return this.options.log ?? silentLogger
  }

  onMessage(handler: InboundHandler): void {
    this.handler = handler
  }

  async connect(): Promise<void> {
    this.closing = false
    await mkdir(this.options.authDir, { recursive: true })
    await mkdir(this.options.mediaDir, { recursive: true })

    const { state, saveCreds } = await useMultiFileAuthState(this.options.authDir)
    const { version } = await fetchLatestBaileysVersion()
    const socket = makeWASocket({
      auth: state,
      version,
      syncFullHistory: true,
    })
    this.socket = socket

    socket.ev.on('creds.update', () => {
      void saveCreds()
    })

    socket.ev.on('connection.update', (update) => {
      if (update.qr) {
        this.log.info('escaneá este QR desde WhatsApp en Dispositivos vinculados')
        // Baileys exposes only the QR payload; linked-device setup requires rendering it.
        qrcode.generate(update.qr, { small: true })
      }
      if (update.connection === 'open') {
        this.reconnectDelayMs = 1_000
        this.open = true
        this.settleReadyWaiters()
        this.log.info('conexión establecida con WhatsApp')
      }
      if (update.connection === 'close') {
        void this.handleClose(update.lastDisconnect?.error)
      }
    })

    socket.ev.on('messages.upsert', ({ messages }) => {
      void this.dispatch(messages)
    })

    socket.ev.on('messaging-history.set', ({ messages }) => {
      void this.dispatch(messages)
    })
  }

  async waitUntilReady(timeoutMs = 120_000): Promise<void> {
    if (this.open) return
    await new Promise<void>((resolve, reject) => {
      let waiter: ReadyWaiter
      const timer = setTimeout(() => {
        const index = this.readyWaiters.indexOf(waiter)
        if (index === -1) return
        this.readyWaiters.splice(index, 1)
        clearTimeout(waiter.timer)
        reject(new Error(`La conexión no estuvo lista en ${timeoutMs} ms`))
      }, timeoutMs)
      waiter = { resolve, reject, timer }
      this.readyWaiters.push(waiter)
    })
  }

  private settleReadyWaiters(error?: Error): void {
    for (const waiter of this.readyWaiters.splice(0)) {
      clearTimeout(waiter.timer)
      if (error) waiter.reject(error)
      else waiter.resolve()
    }
  }

  private async dispatch(waMessages: readonly WAMessage[]): Promise<void> {
    const handler = this.handler
    const selfJid = this.socket?.user?.id
    if (!handler || !selfJid) return

    for (const raw of waMessages) {
      const normalized = normalizeWAMessage(raw, selfJid)
      if (!normalized) continue
      try {
        await handler(normalized)
      } catch (error) {
        this.log.error('el manejador falló con un mensaje entrante', {
          externalId: normalized.externalId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  private async handleClose(error: unknown): Promise<void> {
    this.open = false
    if (this.closing) return

    const statusCode =
      typeof error === 'object' && error !== null && 'output' in error
        ? (error as { output?: { statusCode?: number } }).output?.statusCode
        : undefined

    if (statusCode === DisconnectReason.loggedOut) {
      this.log.error(
        'la sesión se cerró desde el teléfono: borrá el directorio de credenciales y volvé a vincular',
        { authDir: this.options.authDir },
      )
      this.settleReadyWaiters(
        new Error('La sesión de WhatsApp fue cerrada desde el teléfono'),
      )
      return
    }

    const delay = this.reconnectDelayMs
    this.reconnectDelayMs = Math.min(delay * 2, 60_000)
    this.log.warn('conexión caída, reintentando', { enMs: delay })
    await Bun.sleep(delay)
    if (!this.closing) await this.connect()
  }

  async disconnect(): Promise<void> {
    this.closing = true
    this.open = false
    this.settleReadyWaiters(new Error('Se cerró la conexión antes de estar lista'))
    await this.socket?.end(undefined)
    this.socket = null
  }

  async send(
    target: ConversationRef,
    content: OutboundContent,
    idempotencyKey: string,
  ): Promise<SentMessage> {
    if (!this.socket) throw new Error('WhatsAppProvider sin conectar')
    const sent = await this.socket.sendMessage(
      target.externalId,
      { text: content.text },
      { messageId: idempotencyKey },
    )
    return { externalId: sent?.key.id ?? idempotencyKey }
  }

  async downloadAttachment(
    message: InboundMessage,
    attachmentExternalId: string,
  ): Promise<DownloadedMedia> {
    const buffer = await downloadMediaMessage(
      message.raw as Parameters<typeof downloadMediaMessage>[0],
      'buffer',
      {},
    )
    // Normalization emits one attachment per message, so the attachment id only names its bytes.
    const localPath = join(this.options.mediaDir, attachmentExternalId.replace(/[/:]/g, '_'))
    await Bun.write(localPath, buffer)
    return { localPath, sizeBytes: buffer.byteLength }
  }

  async listConversations(): Promise<ConversationSummary[]> {
    if (!this.socket) throw new Error('WhatsAppProvider sin conectar')
    const groups = await this.socket.groupFetchAllParticipating()
    return Object.values(groups).map((group) => ({
      externalId: group.id,
      kind: 'group',
      name: group.subject ?? null,
      participantCount: group.participants?.length ?? null,
    }))
  }
}
