import { interpret } from '../agent/interpret.ts'
import type { Embedder } from '../agent/llm/embedder.ts'
import type { Llm } from '../agent/llm/port.ts'
import type { MediaModel } from '../agent/media/port.ts'
import { getResolvedPreferences } from '../agent/preferences.ts'
import { summarize } from '../agent/summarize/index.ts'
import type { Config } from '../config/index.ts'
import { describeError, type Logger } from '../domain/logger.ts'
import type { MessagingProvider } from '../domain/provider.ts'
import type { InboundMessage } from '../domain/types.ts'
import type { Db } from '../store/client.ts'
import { isBotMessage } from '../store/repositories/bot-messages.ts'
import { enqueueOutbound } from '../store/repositories/outbox.ts'
import { BOT_PREFIX, classifyControlMessage } from './classify.ts'
import { assertControlTarget } from './guard.ts'

export const HELP_REPLY =
  `${BOT_PREFIX}Ask me to summarize a chat by name or alias (e.g. "summarize la facu today"). ` +
  'I can use today, yesterday, this week, or a custom range.'

export function createControlLoop(deps: {
  db: Db
  config: Pick<Config, 'CONTROL_PROVIDER' | 'CONTROL_CONVERSATION_ID'>
  log: Logger
  llm: Llm
  embedder?: Embedder
  provider?: MessagingProvider
  media?: MediaModel
}) {
  async function handle(message: InboundMessage): Promise<void> {
    const conversationId = deps.config.CONTROL_CONVERSATION_ID
    if (!conversationId) return

    try {
      const known = await isBotMessage(deps.db, message.provider, message.externalId)
      if (
        classifyControlMessage({
          message,
          control: { provider: deps.config.CONTROL_PROVIDER, conversationId },
          isKnownBotMessage: known,
        }) !== 'request'
      ) {
        return
      }

      const target = { provider: message.provider, externalId: conversationId }
      assertControlTarget(deps.config, target)

      let text: string
      try {
        text = await buildReply(deps, message, conversationId)
      } catch (error) {
        deps.log.error('control could not complete request', {
          externalId: message.externalId,
          error: describeError(error),
        })
        text = `${BOT_PREFIX}Could not complete the request: ${describeError(error)}`
      }

      await enqueueOutbound(deps.db, {
        provider: target.provider,
        conversationExternalId: target.externalId,
        text,
        idempotencyKey: crypto.randomUUID(),
      })
    } catch (error) {
      deps.log.warn('control could not enqueue reply', {
        externalId: message.externalId,
        error: describeError(error),
      })
    }
  }

  return { handle }
}

async function buildReply(
  deps: {
    db: Db
    llm: Llm
    config: Pick<Config, 'CONTROL_PROVIDER' | 'CONTROL_CONVERSATION_ID'>
    embedder?: Embedder
    provider?: MessagingProvider
    media?: MediaModel
  },
  message: InboundMessage,
  controlExternalId: string,
): Promise<string> {
  const globalPrefs = await getResolvedPreferences(deps.db, null)
  const result = await interpret({
    db: deps.db,
    llm: deps.llm,
    provider: message.provider,
    controlExternalId,
    text: message.text ?? '',
    now: message.sentAt,
    timezone: globalPrefs.timezone,
  })

  switch (result.kind) {
    case 'help':
      return HELP_REPLY
    case 'ask':
      return withBotPrefix(result.question)
    case 'request': {
      const preferences = await getResolvedPreferences(deps.db, result.request.conversationId)
      const summary = await summarize({
        db: deps.db,
        llm: deps.llm,
        request: result.request,
        preferences,
        embedder: deps.embedder,
        provider: deps.provider,
        media: deps.media,
      })
      return withBotPrefix(summary)
    }
  }
}

function withBotPrefix(text: string): string {
  return text.startsWith(BOT_PREFIX) ? text : `${BOT_PREFIX}${text}`
}
