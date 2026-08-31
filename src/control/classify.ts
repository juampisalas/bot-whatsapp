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
