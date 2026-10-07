import type { InboundMessage, ProviderId } from '../domain/types.ts'

export const BOT_PREFIX = '✦ '

export function classifyControlMessage(input: {
  message: InboundMessage
  control: { provider: ProviderId; conversationId: string }
  isKnownBotMessage: boolean
}): 'request' | 'ignore' {
  const { message, control, isKnownBotMessage } = input
  if (message.provider !== control.provider) return 'ignore'
  if (message.conversation.externalId !== control.conversationId) return 'ignore'
  if (!message.fromSelf) return 'ignore'
  if (isKnownBotMessage) return 'ignore'
  const text = message.text?.trim() ?? ''
  if (text.length === 0) return 'ignore'
  if (text.startsWith(BOT_PREFIX.trimEnd()) || text.startsWith(BOT_PREFIX)) return 'ignore'
  return 'request'
}

/**
 * Control answers a message only the first time it is captured, and only when
 * WhatsApp delivered it live.
 */
export function shouldAnswerControlMessage(input: {
  historical: boolean
  newlyCaptured: boolean
}): boolean {
  return input.newlyCaptured && !input.historical
}

/**
 * A control command that arrives from history or the offline backlog will not be
 * answered, so there is nothing to keep. Live commands stay stored.
 */
export function shouldDiscardUnansweredControlMessage(input: {
  message: InboundMessage
  controlConversationId: string | undefined
}): boolean {
  if (!input.controlConversationId || input.message.historical !== true) return false
  if (input.message.conversation.externalId !== input.controlConversationId) return false
  if (!input.message.fromSelf) return false
  const text = input.message.text?.trim() ?? ''
  if (text.length === 0) return false
  if (text.startsWith(BOT_PREFIX.trimEnd()) || text.startsWith(BOT_PREFIX)) return false
  return true
}
