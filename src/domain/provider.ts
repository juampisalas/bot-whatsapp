import type {
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

export interface MessagingProvider {
  readonly id: ProviderId

  /**
   * Establece la conexión. No asume tiempo real: un adaptador que
   * internamente hace polling cumple el contrato igual.
   */
  connect(): Promise<void>

  /**
   * Resuelve cuando el canal está listo para operar. Existe porque
   * `connect` solo inicia el proceso: en WhatsApp puede hacer falta que
   * el usuario escanee un QR antes de que haya sesión utilizable.
   * Rechaza si vence el tiempo o si la sesión quedó cerrada.
   */
  waitUntilReady(timeoutMs?: number): Promise<void>

  disconnect(): Promise<void>

  /** Registra el manejador de mensajes entrantes. */
  onMessage(handler: InboundHandler): void

  /**
   * Registra el aviso de que el canal quedó inutilizable y no vuelve solo: hace falta
   * intervenir, típicamente revincular. Existe porque un fallo así puede llegar mucho
   * después de conectar, cuando `waitUntilReady` ya resolvió y no queda nadie mirando;
   * sin este canal el proceso sigue en pie sin capturar nada y sin poder avisarlo.
   */
  onFatal(handler: FatalHandler): void

  /**
   * Envía un mensaje. `idempotencyKey` se usa como identificador del
   * mensaje cuando el canal lo permite, para que un reintento no
   * produzca un duplicado.
   */
  send(
    target: ConversationRef,
    content: OutboundContent,
    idempotencyKey: string,
  ): Promise<SentMessage>

  /** Descarga un adjunto de un mensaje ya recibido. */
  downloadAttachment(message: InboundMessage, attachmentExternalId: string): Promise<DownloadedMedia>

  listConversations(): Promise<ConversationSummary[]>
}
