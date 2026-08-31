import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from 'baileys'
import qrcode from 'qrcode-terminal'
import { describeError, silentLogger, type Logger } from '../../domain/logger.ts'
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
import { decodeRaw } from '../../store/raw.ts'
import { createBaileysLogger } from './baileys-logger.ts'
import { normalizeWAMessage } from './normalize.ts'

const DISPATCH_DRAIN_TIMEOUT_MS = 10_000
const DEFAULT_READY_TIMEOUT_MS = 600_000

/** Attachment bytes already resolved from the original baileys payload. */
export type MediaDownloader = (message: WAMessage) => Promise<Uint8Array>

export interface WhatsAppProviderOptions {
  authDir: string
  mediaDir: string
  log?: Logger
  socketFactory?: () => WASocket | Promise<WASocket>
  /** Injected for the same reason as `socketFactory`: test without hitting the network. */
  downloadMedia?: MediaDownloader
}

/** JIDs include `:` for the device, and neither separator belongs in a filename. */
function sanitizePathSegment(value: string): string {
  return value.replace(/[/:]/g, '_')
}

/**
 * Extension from the mimetype already present on the attachment, only when the subtype is
 * short and alphanumeric. Long Office mimetypes do not yield a usable extension, and a
 * bare name is preferable to one with a whole subtype glued on.
 */
function extensionFromMime(mimeType: string | null): string {
  const subtype = mimeType?.split(';')[0]?.split('/')[1]?.trim() ?? ''
  return /^[a-z0-9]{1,8}$/i.test(subtype) ? `.${subtype}` : ''
}

interface ReadyWaiter {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  timeoutMs: number
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
  private conversationMetaHandler: ConversationMetaHandler | null = null
  private state: ConnectionState = 'idle'
  private terminalError: Error | null = null
  private generation = 0
  private lifecycleTask: Promise<void> | null = null
  private cancelReconnectDelay: (() => void) | null = null
  private reconnectDelayMs = 1_000
  private readonly readyWaiters: ReadyWaiter[] = []
  private readonly inFlightDispatches = new Set<Promise<void>>()
  private readonly groupNames = new Map<string, string>()

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

  onConversationMeta(handler: ConversationMetaHandler): void {
    this.conversationMetaHandler = handler
  }

  /** The notice runs inside a baileys event: if it throws, shutdown must still continue. */
  private emitFatal(error: Error): void {
    try {
      this.fatalHandler?.(error)
    } catch (failure) {
      this.log.error('terminal failure notice threw', { error: describeError(failure) })
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

    // Logout is terminal until an explicit attempt signals that credentials were fixed.
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
        this.log.error('could not save WhatsApp credentials', {
          error: describeError(error),
        })
      })
    })

    socket.ev.on('connection.update', (update) => {
      if (!this.isCurrentSocket(socket, generation)) return
      if (update.qr) {
        this.log.info('scan this QR from WhatsApp → Linked devices')
        this.bumpReadyWaiters()
        // Baileys only delivers the QR payload: linking the device requires drawing it.
        qrcode.generate(update.qr, { small: true })
      }
      if (update.connection === 'open') {
        this.reconnectDelayMs = 1_000
        this.state = 'open'
        this.settleReadyWaiters()
        this.log.info('WhatsApp connection established')
        void this.refreshGroupNames(socket)
      }
      if (update.connection === 'close') {
        this.handleClose(socket, generation, update.lastDisconnect?.error)
      }
    })

    socket.ev.on('messages.upsert', ({ messages }) => {
      if (!this.isCurrentSocket(socket, generation)) return
      this.trackDispatch(this.dispatch(messages, socket))
    })

    socket.ev.on('messaging-history.set', ({ messages }) => {
      if (!this.isCurrentSocket(socket, generation)) return
      this.trackDispatch(this.dispatch(messages, socket))
    })

    socket.ev.on('groups.upsert', (groups) => {
      if (!this.isCurrentSocket(socket, generation)) return
      for (const group of groups) {
        this.applyGroupName(group.id, group.subject)
      }
    })

    socket.ev.on('groups.update', (updates) => {
      if (!this.isCurrentSocket(socket, generation)) return
      for (const update of updates) {
        const id = update.id
        if (!id || update.subject === undefined) continue
        this.applyGroupName(id, update.subject)
      }
    })
  }

  private applyGroupName(id: string, subject: string): void {
    this.groupNames.set(id, subject)
    void this.conversationMetaHandler?.({
      externalId: id,
      kind: 'group',
      name: subject ?? null,
    })
  }

  private async refreshGroupNames(socket: WASocket): Promise<void> {
    try {
      const groups = await socket.groupFetchAllParticipating()
      for (const group of Object.values(groups)) {
        this.groupNames.set(group.id, group.subject)
        void this.conversationMetaHandler?.({
          externalId: group.id,
          kind: 'group',
          name: group.subject ?? null,
        })
      }
    } catch (error) {
      this.log.error('failed to refresh WhatsApp group names', {
        error: describeError(error),
      })
    }
  }

  /**
   * Tracks the dispatch so `disconnect` can wait for it. Without this, a message that
   * arrives alongside the shutdown signal keeps running while shutdown closes the
   * database: its persistence fails, falls to the buffer, and nobody drains that buffer.
   */
  private trackDispatch(dispatch: Promise<void>): void {
    // Tracking absorbs rejection: shutdown is the waiter, and a dispatch failure must
    // not block releasing resources.
    const tracked = dispatch
      .catch((error: unknown) => {
        this.log.error('inbound message dispatch failed', {
          error: describeError(error),
        })
      })
      .finally(() => {
        this.inFlightDispatches.delete(tracked)
      })
    this.inFlightDispatches.add(tracked)
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
      logger: createBaileysLogger(this.log),
    })
    return { socket, saveCreds }
  }

  async waitUntilReady(timeoutMs = DEFAULT_READY_TIMEOUT_MS): Promise<void> {
    if (this.state === 'open') return
    if (this.terminalError) throw this.terminalError
    await new Promise<void>((resolve, reject) => {
      let waiter: ReadyWaiter
      const timer = setTimeout(() => {
        const index = this.readyWaiters.indexOf(waiter)
        if (index === -1) return
        this.readyWaiters.splice(index, 1)
        clearTimeout(waiter.timer)
        reject(new Error(`connection was not ready within ${timeoutMs} ms`))
      }, timeoutMs)
      waiter = { resolve, reject, timer, timeoutMs }
      this.readyWaiters.push(waiter)
    })
  }

  /** Resets each waiter's timer so a later QR does not expire on the first QR's clock. */
  private bumpReadyWaiters(): void {
    for (const waiter of this.readyWaiters) {
      clearTimeout(waiter.timer)
      waiter.timer = setTimeout(() => {
        const index = this.readyWaiters.indexOf(waiter)
        if (index === -1) return
        this.readyWaiters.splice(index, 1)
        clearTimeout(waiter.timer)
        waiter.reject(new Error(`connection was not ready within ${waiter.timeoutMs} ms`))
      }, waiter.timeoutMs)
    }
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
    const ownId = socket.user?.id
    if (!handler) return
    if (!ownId) {
      this.log.error('dropping inbound messages: baileys has not reported the own id yet', {
        messages: waMessages.length,
      })
      return
    }

    // Baileys reports the own id with the device that came from pair-success
    // (`<number>:<device>@s.whatsapp.net`). Without normalizing it, own messages land under
    // a participant that is not the JID others see you as, and every re-link creates a new
    // row in `participants`.
    const selfJid = jidNormalizedUser(ownId)

    for (const raw of waMessages) {
      const normalized = normalizeWAMessage(raw, selfJid, {
        groupName: this.groupNames.get(raw.key?.remoteJid ?? '') ?? null,
      })
      if (!normalized) continue
      try {
        await handler(normalized)
      } catch (error) {
        this.log.error('inbound handler failed for a message', {
          externalId: normalized.externalId,
          error: describeError(error),
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
      this.terminalError = new Error('WhatsApp session was closed from the phone')
      this.log.error(
        'session closed from the phone: delete the credentials directory and re-link',
        { authDir: this.options.authDir },
      )
      this.settleReadyWaiters(this.terminalError)
      // Last: whoever listens for terminal failure often responds by shutting down, and
      // shutdown disconnects. Notifying earlier would make pending waits reject for the
      // disconnect instead of the real reason.
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
      this.log.warn('connection dropped, retrying', { inMs: delay })
      await this.waitForReconnectDelay(delay)
      if (this.state !== 'reconnecting') return

      try {
        const installed = await this.installSocket()
        if (installed) return
      } catch (error) {
        if (this.state !== 'reconnecting') return
        this.log.error('failed to prepare WhatsApp connection', {
          error: describeError(error),
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
      this.log.warn('failed to end WhatsApp socket', {
        error: describeError(error),
      })
    }
  }

  async disconnect(): Promise<void> {
    const error = new Error('connection closed before it was ready')
    this.generation += 1
    this.state = 'closed'
    this.terminalError = error
    this.cancelReconnectDelay?.()
    this.settleReadyWaiters(error)
    const socket = this.socket
    this.socket = null
    if (socket) await this.endSocket(socket)
    // After releasing the socket: generation already advanced, so no new dispatch enters
    // and what remains here is finite — still capped so shutdown cannot hang forever.
    if (this.inFlightDispatches.size > 0) {
      await Promise.race([
        Promise.all([...this.inFlightDispatches]),
        new Promise<void>((resolve) => setTimeout(resolve, DISPATCH_DRAIN_TIMEOUT_MS)),
      ])
    }
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
    const download =
      this.options.downloadMedia ??
      ((raw: WAMessage) => downloadMediaMessage(raw, 'buffer', {}))
    // Persist stores binaries as `{ $bin: 'b64', data }`; restore Uint8Array leaves so
    // Baileys downloadMediaMessage can read mediaKey (and siblings) on retry.
    const raw = decodeRaw(message.raw) as WAMessage
    const buffer = await download(raw)

    const mimeType =
      message.attachments.find((attachment) => attachment.externalId === attachmentExternalId)
        ?.mimeType ?? null
    // WhatsApp message ids are unique within a chat; conversation is in the path so same
    // attachment ids from different chats do not collide on disk.
    const localPath = join(
      this.options.mediaDir,
      sanitizePathSegment(message.conversation.externalId),
      `${sanitizePathSegment(attachmentExternalId)}${extensionFromMime(mimeType)}`,
    )
    await Bun.write(localPath, buffer)
    return { localPath, sizeBytes: buffer.byteLength }
  }

  async listConversations(): Promise<ConversationSummary[]> {
    const groups = await this.usableSocket().groupFetchAllParticipating()
    return Object.values(groups).map((group) => {
      this.groupNames.set(group.id, group.subject)
      return {
        externalId: group.id,
        kind: 'group' as const,
        name: group.subject ?? null,
        participantCount: group.participants?.length ?? null,
      }
    })
  }

  private usableSocket(): WASocket {
    if (this.state === 'open' && this.socket) return this.socket
    throw this.terminalError ?? new Error('WhatsAppProvider is not connected')
  }
}
