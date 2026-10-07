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
import type { ProviderId } from '../domain/types.ts'
import type { Db } from '../store/client.ts'
import { isBotMessage } from '../store/repositories/bot-messages.ts'
import { enqueueOutbound } from '../store/repositories/outbox.ts'
import { BOT_PREFIX, classifyControlMessage } from './classify.ts'
import { matchControlCommand } from './commands.ts'
import {
  helpReply,
  isLanguageClarification,
  languageClarificationText,
  languagePrompt,
  languageSaved,
  parseLanguageChoice,
  parseLanguageCommand,
  refreshNamesStarted,
  refreshNamesUnavailable,
  requestFailed,
  type ReplyLanguage,
} from './i18n.ts'
import {
  enqueueControlReply,
  enqueueRefreshNamesFollowUp,
} from './refresh-names.ts'
import { assertControlTarget } from './guard.ts'
import { applySetChatNameCommand, parseSetChatNameCommand } from './set-chat-name.ts'
import {
  formatContactSearchResults,
  parseSearchContactCommand,
  runContactSearch,
} from './search-contact.ts'
import { CLARIFICATION_TTL_MS } from '../agent/interpret.ts'
import {
  clearClarification,
  loadActiveClarification,
  saveClarification,
} from '../store/repositories/clarifications.ts'
import {
  loadGlobalPreferences,
  upsertGlobalPreferences,
} from '../store/repositories/preferences.ts'
import type { ConversationHit } from '../store/repositories/conversations.ts'

export { HELP_REPLY } from './commands.ts'

async function loadInterfaceLanguage(db: Db): Promise<ReplyLanguage | null> {
  const row = await loadGlobalPreferences(db)
  const value = row?.language?.trim().toLowerCase()
  if (value === 'es' || value === 'español' || value === 'spanish') return 'es'
  if (value === 'en' || value === 'english') return 'en'
  return null
}

async function routeLanguage(
  db: Db,
  target: { provider: ProviderId; externalId: string },
  message: InboundMessage,
): Promise<{ kind: 'reply'; text: string } | { kind: 'continue'; language: ReplyLanguage; text: string }> {
  const incoming = message.text ?? ''
  const pending = await loadActiveClarification(db, target.provider, target.externalId, message.sentAt)
  let language = await loadInterfaceLanguage(db)
  let text = incoming

  if (pending && isLanguageClarification(pending.originalText)) {
    const picked = parseLanguageChoice(incoming)
    if (!picked) return { kind: 'reply', text: languagePrompt() }
    await upsertGlobalPreferences(db, { language: picked })
    await clearClarification(db, target.provider, target.externalId)
    language = picked
    const original = languageClarificationText(pending.originalText)
    if (!original || parseLanguageCommand(original) !== null || original === incoming) {
      return { kind: 'reply', text: languageSaved(picked) }
    }
    text = original
  }

  const explicit = parseLanguageCommand(text)
  if (explicit === 'ask') return { kind: 'reply', text: languagePrompt() }
  if (explicit === 'en' || explicit === 'es') {
    await upsertGlobalPreferences(db, { language: explicit })
    return { kind: 'reply', text: languageSaved(explicit) }
  }

  if (language === null) {
    await saveClarification(db, {
      provider: target.provider,
      conversationExternalId: target.externalId,
      originalText: JSON.stringify({ kind: 'pick_language', userText: text }),
      question: languagePrompt(),
      expiresAt: new Date(message.sentAt.getTime() + CLARIFICATION_TTL_MS),
    })
    return { kind: 'reply', text: languagePrompt() }
  }

  return { kind: 'continue', language, text }
}

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

      const routed = await routeLanguage(deps.db, target, message)
      if (routed.kind === 'reply') {
        await enqueueControlReply(deps.db, target, routed.text)
        return
      }
      const language = routed.language
      const text = routed.text

      const setName = parseSetChatNameCommand(text)
      if (setName) {
        const reply = await applySetChatNameCommand(
          deps.db,
          message.provider,
          setName,
          deps.provider,
          language,
        )
        await enqueueControlReply(deps.db, target, reply)
        return
      }

      const searchContactQuery = parseSearchContactCommand(text)
      if (searchContactQuery) {
        const { hits, text: reply } = await runContactSearch(
          deps.db,
          message.provider,
          searchContactQuery,
          deps.provider,
          language,
        )
        if (hits.length > 1) {
          await saveContactPickClarification(
            deps.db,
            target,
            searchContactQuery,
            hits,
            message.sentAt,
            language,
          )
        }
        await enqueueControlReply(deps.db, target, reply)
        return
      }

      const command = matchControlCommand(text)
      if (command === 'refresh_names') {
        if (!deps.provider?.refreshContactNames) {
          await enqueueControlReply(deps.db, target, refreshNamesUnavailable(language))
          return
        }
        await enqueueControlReply(deps.db, target, refreshNamesStarted(language))
        void enqueueRefreshNamesFollowUp({ ...deps, target, language })
        return
      }

      if (command === 'help') {
        await enqueueControlReply(deps.db, target, helpReply(language))
        return
      }

      let reply: string
      try {
        reply = await buildReply(deps, { ...message, text }, conversationId, language)
      } catch (error) {
        deps.log.error('control could not complete request', {
          externalId: message.externalId,
          error: describeError(error),
        })
        reply = requestFailed(language, describeError(error))
      }

      await enqueueOutbound(deps.db, {
        provider: target.provider,
        conversationExternalId: target.externalId,
        text: reply,
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

async function saveContactPickClarification(
  db: Db,
  target: { provider: ProviderId; externalId: string },
  query: string,
  hits: ConversationHit[],
  now: Date,
  language: ReplyLanguage,
): Promise<void> {
  await saveClarification(db, {
    provider: target.provider,
    conversationExternalId: target.externalId,
    originalText: JSON.stringify({
      kind: 'pick_conversation',
      conversationQuery: query,
      candidateIds: hits.map((hit) => hit.id),
      conversationId: null,
      range: null,
      lastNDays: null,
      lastNHours: null,
      isoFrom: null,
      isoTo: null,
      focus: null,
      userText: `buscar contacto ${query}`,
    }),
    question: formatContactSearchResults(query, hits, language),
    expiresAt: new Date(now.getTime() + CLARIFICATION_TTL_MS),
  })
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
  language: ReplyLanguage,
): Promise<string> {
  const command = matchControlCommand(message.text ?? '')
  if (command === 'help') return helpReply(language)

  const globalPrefs = await getResolvedPreferences(deps.db, null)
  const result = await interpret({
    db: deps.db,
    llm: deps.llm,
    provider: message.provider,
    channel: deps.provider,
    controlExternalId,
    text: message.text ?? '',
    now: message.sentAt,
    timezone: globalPrefs.timezone,
    language,
  })

  switch (result.kind) {
    case 'help':
      return helpReply(language)
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
