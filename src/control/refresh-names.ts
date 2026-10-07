import { describeError } from '../domain/logger.ts'
import type { Logger } from '../domain/logger.ts'
import type { MessagingProvider } from '../domain/provider.ts'
import type { ProviderId } from '../domain/types.ts'
import type { Db } from '../store/client.ts'
import { enqueueOutbound } from '../store/repositories/outbox.ts'
import { BOT_PREFIX } from './classify.ts'
import type { ReplyLanguage } from './i18n.ts'
import {
  formatRefreshDoneReply,
  formatRefreshFailedReply,
  REFRESH_NAMES_STARTED_REPLY,
  REFRESH_NAMES_UNAVAILABLE_REPLY,
} from './commands.ts'

export async function enqueueRefreshNamesFollowUp(deps: {
  db: Db
  log: Logger
  provider?: MessagingProvider
  target: { provider: ProviderId; externalId: string }
  language?: ReplyLanguage
}): Promise<void> {
  const language = deps.language ?? 'en'
  if (!deps.provider?.refreshContactNames) return

  try {
    const result = await deps.provider.refreshContactNames()
    await enqueueControlReply(deps.db, deps.target, formatRefreshDoneReply(result, language))
  } catch (error) {
    deps.log.error('contact name refresh failed', { error: describeError(error) })
    await enqueueControlReply(
      deps.db,
      deps.target,
      formatRefreshFailedReply(describeError(error), language),
    )
  }
}

export async function enqueueControlReply(
  db: Db,
  target: { provider: ProviderId; externalId: string },
  text: string,
): Promise<void> {
  await enqueueOutbound(db, {
    provider: target.provider,
    conversationExternalId: target.externalId,
    text: text.startsWith(BOT_PREFIX) ? text : `${BOT_PREFIX}${text}`,
    idempotencyKey: crypto.randomUUID(),
  })
}

export {
  REFRESH_NAMES_STARTED_REPLY,
  REFRESH_NAMES_UNAVAILABLE_REPLY,
}
