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
import { describirError, silentLogger, type Logger } from '../../domain/logger.ts'
import type { FatalHandler, InboundHandler, MessagingProvider } from '../../domain/provider.ts'
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
  socketFactory?: () => WASocket | Promise<WASocket>
}

interface ReadyWaiter {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'loggedOut'
  | 'closed'

export class WhatsAppProvider implements MessagingProvider {
  readonly id: ProviderId = 'whatsapp'

  private socket: WASocket | null = null
  private handler: InboundHandler | null = null
  private fatalHandler: FatalHandler | null = null
  private state: ConnectionState = 'idle'
  private terminalError: Error | null = null
  private generation = 0
  private lifecycleTask: Promise<void> | null = null
  private cancelReconnectDelay: (() => void) | null = null
  private reconnectDelayMs = 1_000
  private readonly readyWaiters: ReadyWaiter[] = []
  private readonly despachosEnVuelo = new Set<Promise<void>>()

  constructor(private readonly options: WhatsAppProviderOptions) {}

  private get log(): Logger {
    return this.options.log ?? silentLogger
  }

  onMessage(handler: InboundHandler): void {
    this.handler = handler
  }

  onFatal(handler: FatalHandler): void {
    this.fatalHandler = handler
  }

  /** El aviso corre dentro de un evento de baileys: si rompe, el cierre tiene que seguir. */
  private emitFatal(error: Error): void {
    try {
      this.fatalHandler?.(error)
    } catch (fallo) {
      this.log.error('falló el aviso de fallo terminal', { error: describirError(fallo) })
    }
  }

  async connect(): Promise<void> {
    if (this.state === 'open' || this.state === 'connecting' || this.state === 'reconnecting') {
      if (this.lifecycleTask) await this.lifecycleTask
      return
    }
    if (this.lifecycleTask) {
      await this.lifecycleTask
      return this.connect()
    }

    // Logout is terminal until an explicit retry signals that credentials were repaired.
    this.terminalError = null
    this.state = 'connecting'
    const task = this.runExplicitConnect()
    this.lifecycleTask = task
    try {
      await task
    } finally {
      this.finishLifecycleTask(task)
    }
  }

  private async runExplicitConnect(): Promise<void> {
    try {
      await this.installSocket()
    } catch (error) {
      if (this.state === 'connecting') this.state = 'idle'
      throw error
    }
  }

  private async installSocket(): Promise<boolean> {
    const generation = ++this.generation
    const { socket, saveCreds } = await this.createSocket()
    if (!this.isAttemptCurrent(generation)) {
      await this.endSocket(socket)
      return false
    }

    const previous = this.socket
    if (previous && previous !== socket) await this.endSocket(previous)
    if (!this.isAttemptCurrent(generation)) {
      await this.endSocket(socket)
      return false
    }

    this.socket = socket
    this.bindSocket(socket, generation, saveCreds)
    return true
  }

  private isAttemptCurrent(generation: number): boolean {
    return (
      generation === this.generation &&
      (this.state === 'connecting' || this.state === 'reconnecting')
    )
  }

  private isCurrentSocket(socket: WASocket, generation: number): boolean {
    return this.socket === socket && this.generation === generation
  }

  private bindSocket(
    socket: WASocket,
    generation: number,
    saveCreds: () => Promise<void>,
  ): void {
    socket.ev.on('creds.update', () => {
      if (!this.isCurrentSocket(socket, generation)) return
      void saveCreds().catch((error: unknown) => {
        this.log.error('no se pudieron guardar las credenciales de WhatsApp', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    })

    socket.ev.on('connection.update', (update) => {
      if (!this.isCurrentSocket(socket, generation)) return
      if (update.qr) {
        this.log.info('escaneá este QR desde WhatsApp en Dispositivos vinculados')
        // Baileys exposes only the QR payload; linked-device setup requires rendering it.
        qrcode.generate(update.qr, { small: true })
      }
      if (update.connection === 'open') {
        this.reconnectDelayMs = 1_000
        this.state = 'open'
        this.settleReadyWaiters()
        this.log.info('conexión establecida con WhatsApp')
      }
      if (update.connection === 'close') {
        this.handleClose(socket, generation, update.lastDisconnect?.error)
      }
    })

    socket.ev.on('messages.upsert', ({ messages }) => {
      if (!this.isCurrentSocket(socket, generation)) return
      this.seguirDespacho(this.dispatch(messages, socket))
    })

    socket.ev.on('messaging-history.set', ({ messages }) => {
      if (!this.isCurrentSocket(socket, generation)) return
      this.seguirDespacho(this.dispatch(messages, socket))
    })
  }

  /**
   * Anota el despacho para que `disconnect` lo espere. Sin esto, un mensaje que llega
   * junto con la señal sigue corriendo mientras el apagado cierra la base: su
   * persistencia falla, cae al buffer, y ese buffer ya nadie lo vacía.
   */
  private seguirDespacho(despacho: Promise<void>): void {
    // El seguimiento absorbe el rechazo: quien espera es el apagado, y ahí un fallo de
    // despacho no debería impedir cerrar los recursos.
    const seguimiento = despacho
      .catch((error: unknown) => {
        this.log.error('falló el despacho de mensajes entrantes', {
          error: describirError(error),
        })
      })
      .finally(() => {
        this.despachosEnVuelo.delete(seguimiento)
      })
    this.despachosEnVuelo.add(seguimiento)
  }

  private async createSocket(): Promise<{
    socket: WASocket
    saveCreds: () => Promise<void>
  }> {
    if (this.options.socketFactory) {
      return {
        socket: await this.options.socketFactory(),
        saveCreds: async () => {},
      }
    }

    await mkdir(this.options.authDir, { recursive: true })
    await mkdir(this.options.mediaDir, { recursive: true })

    const { state, saveCreds } = await useMultiFileAuthState(this.options.authDir)
    const { version } = await fetchLatestBaileysVersion()
    const socket = makeWASocket({
      auth: state,
      version,
      syncFullHistory: true,
    })
    return { socket, saveCreds }
  }

  async waitUntilReady(timeoutMs = 120_000): Promise<void> {
    if (this.state === 'open') return
    if (this.terminalError) throw this.terminalError
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

  private async dispatch(waMessages: readonly WAMessage[], socket: WASocket): Promise<void> {
    const handler = this.handler
    const selfJid = socket.user?.id
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

  private handleClose(socket: WASocket, generation: number, error: unknown): void {
    if (!this.isCurrentSocket(socket, generation)) return
    this.socket = null
    const statusCode =
      typeof error === 'object' && error !== null && 'output' in error
        ? (error as { output?: { statusCode?: number } }).output?.statusCode
        : undefined

    if (statusCode === DisconnectReason.loggedOut) {
      this.state = 'loggedOut'
      this.generation += 1
      this.terminalError = new Error('La sesión de WhatsApp fue cerrada desde el teléfono')
      this.log.error(
        'la sesión se cerró desde el teléfono: borrá el directorio de credenciales y volvé a vincular',
        { authDir: this.options.authDir },
      )
      this.settleReadyWaiters(this.terminalError)
      // Último: quien escucha el fallo terminal suele responder apagando, y el apagado
      // desconecta. Avisar antes dejaría a las esperas pendientes rechazando por la
      // desconexión en vez de por el motivo real.
      this.emitFatal(this.terminalError)
      return
    }

    this.state = 'reconnecting'
    this.startReconnectLoop()
  }

  private startReconnectLoop(): void {
    if (this.lifecycleTask) return
    const task = this.runReconnectLoop()
    this.lifecycleTask = task
    void task.finally(() => {
      this.finishLifecycleTask(task)
    })
  }

  private finishLifecycleTask(task: Promise<void>): void {
    if (this.lifecycleTask !== task) return
    this.lifecycleTask = null
    if (this.state === 'reconnecting' && this.socket === null) {
      this.startReconnectLoop()
    }
  }

  private async runReconnectLoop(): Promise<void> {
    while (this.state === 'reconnecting') {
      const delay = this.reconnectDelayMs
      this.reconnectDelayMs = Math.min(delay * 2, 60_000)
      this.log.warn('conexión caída, reintentando', { enMs: delay })
      await this.waitForReconnectDelay(delay)
      if (this.state !== 'reconnecting') return

      try {
        const installed = await this.installSocket()
        if (installed) return
      } catch (error) {
        if (this.state !== 'reconnecting') return
        this.log.error('falló la preparación de la conexión de WhatsApp', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  private async waitForReconnectDelay(delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = () => {
        if (timer) clearTimeout(timer)
        if (this.cancelReconnectDelay === finish) this.cancelReconnectDelay = null
        resolve()
      }
      this.cancelReconnectDelay = finish
      timer = setTimeout(finish, delayMs)
    })
  }

  private async endSocket(socket: WASocket): Promise<void> {
    try {
      await socket.end(undefined)
    } catch (error) {
      this.log.warn('falló el cierre del socket de WhatsApp', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async disconnect(): Promise<void> {
    const error = new Error('Se cerró la conexión antes de estar lista')
    this.generation += 1
    this.state = 'closed'
    this.terminalError = error
    this.cancelReconnectDelay?.()
    this.settleReadyWaiters(error)
    const socket = this.socket
    this.socket = null
    if (socket) await this.endSocket(socket)
    // Después de soltar el socket: la generación ya cambió, así que no entra ningún despacho
    // nuevo y lo que queda acá es finito.
    if (this.despachosEnVuelo.size > 0) await Promise.all([...this.despachosEnVuelo])
  }

  async send(
    target: ConversationRef,
    content: OutboundContent,
    idempotencyKey: string,
  ): Promise<SentMessage> {
    const socket = this.usableSocket()
    const sent = await socket.sendMessage(
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
    const groups = await this.usableSocket().groupFetchAllParticipating()
    return Object.values(groups).map((group) => ({
      externalId: group.id,
      kind: 'group',
      name: group.subject ?? null,
      participantCount: group.participants?.length ?? null,
    }))
  }

  private usableSocket(): WASocket {
    if (this.state === 'open' && this.socket) return this.socket
    throw this.terminalError ?? new Error('WhatsAppProvider sin conectar')
  }
}
