import type { Config } from '../config/index.ts'
import { describeError, type Logger } from '../domain/logger.ts'
import type { InboundMessage } from '../domain/types.ts'
import type { Db } from '../store/client.ts'
import { isBotMessage } from '../store/repositories/bot-messages.ts'
import { enqueueOutbound } from '../store/repositories/outbox.ts'
import { classifyControlMessage } from './classify.ts'
import { assertControlTarget } from './guard.ts'
import { replyFor } from './stub.ts'

export function createControlLoop(deps: {
  db: Db
  config: Pick<Config, 'CONTROL_PROVIDER' | 'CONTROL_CONVERSATION_ID'>
  log: Logger
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

      const text = replyFor(message.text ?? '')
      const target = { provider: message.provider, externalId: conversationId }
      assertControlTarget(deps.config, target)
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
