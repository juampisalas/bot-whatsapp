import type { Config } from '../config/index.ts'
import { assertControlTarget, ControlTargetError } from '../control/guard.ts'
import { describeError, type Logger } from '../domain/logger.ts'
import type { MessagingProvider } from '../domain/provider.ts'
import type { Db } from '../store/client.ts'
import { recordBotMessage } from '../store/repositories/bot-messages.ts'
import {
  claimDueOutbound,
  markOutboundFailed,
  markOutboundSent,
} from '../store/repositories/outbox.ts'

export function nextBackoff(attempts: number): Date {
  const seconds = Math.min(60, 2 ** Math.max(0, attempts - 1))
  return new Date(Date.now() + seconds * 1000)
}

export function createDispatcher(deps: {
  db: Db
  provider: MessagingProvider
  config: Pick<Config, 'CONTROL_PROVIDER' | 'CONTROL_CONVERSATION_ID'>
  log: Logger
}) {
  async function tick(now = new Date()): Promise<number> {
    const due = await claimDueOutbound(deps.db, now, 10)
    let sent = 0
    for (const row of due) {
      const target = { provider: row.provider, externalId: row.conversationExternalId }
      try {
        assertControlTarget(deps.config, target)
        const result = await deps.provider.send(target, { text: row.text }, row.idempotencyKey)
        await markOutboundSent(deps.db, row.id, result.externalId)
        await recordBotMessage(deps.db, {
          provider: row.provider,
          externalId: result.externalId,
          outboundId: row.id,
        })
        sent += 1
      } catch (error) {
        const terminal = error instanceof ControlTargetError
        await markOutboundFailed(
          deps.db,
          row.id,
          describeError(error),
          terminal ? now : nextBackoff(row.attempts),
          terminal,
        )
        deps.log.warn('dispatch failed', {
          id: row.id,
          terminal,
          error: describeError(error),
        })
      }
    }
    return sent
  }

  function start(intervalMs: number): () => void {
    const timer = setInterval(() => {
      void tick().catch((error) => {
        deps.log.error('dispatcher tick crashed', { error: describeError(error) })
      })
    }, intervalMs)
    return () => clearInterval(timer)
  }

  return { tick, start }
}
