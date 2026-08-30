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
