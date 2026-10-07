import { z } from 'zod'
import type { MessagingProvider } from '../domain/provider.ts'
import type { ProviderId } from '../domain/types.ts'
import type { Db } from '../store/client.ts'
import {
  clearClarification,
  loadActiveClarification,
  saveClarification,
} from '../store/repositories/clarifications.ts'
import { matchControlCommand } from '../control/commands.ts'
import { formatContactOption } from '../control/search-contact.ts'
import { searchConversationsByName } from '../store/repositories/conversations.ts'
import type { Llm } from './llm/port.ts'
import { tryParseRangeOnly, tryParseSummarizeIntent } from './parse-summarize.ts'
import { resolveConversation, type ConversationHit } from './resolve-conversation.ts'
import {
  cancelled,
  contactNotFound,
  couldNotUnderstand,
  didNotUnderstand,
  rangeHelp,
  whichContact,
  whichConversation,
  type ReplyLanguage,
} from '../control/i18n.ts'

export const CLARIFICATION_TTL_MS = 10 * 60 * 1000

export const RANGE_HELP = rangeHelp('en')

export const InterpretSchema = z.object({
  intent: z.enum(['summarize', 'help', 'unknown']),
  conversationQuery: z.string().nullable(),
  range: z
    .enum(['today', 'yesterday', 'this_week', 'last_n_days', 'last_n_hours', 'iso'])
    .nullable(),
  lastNDays: z.number().int().positive().nullable(),
  lastNHours: z.number().int().positive().nullable(),
  isoFrom: z.string().nullable(),
  isoTo: z.string().nullable(),
  focus: z.string().nullable(),
})

export type InterpretOutput = z.infer<typeof InterpretSchema>

export type RangeSpec = {
  range: NonNullable<InterpretOutput['range']>
  lastNDays: number | null
  lastNHours: number | null
  isoFrom: string | null
  isoTo: string | null
}

export type SummaryRequest = {
  conversationId: string
  from: Date
  to: Date
  focus: string | null
}

export type InterpretResult =
  | { kind: 'request'; request: SummaryRequest }
  | { kind: 'ask'; question: string }
  | { kind: 'help' }

export type InterpretInput = {
  db: Db
  llm: Llm
  provider: ProviderId
  /** Live channel adapter; used to sync contacts when a name is missing locally. */
  channel?: MessagingProvider
  controlExternalId: string
  text: string
  now: Date
  timezone: string
  /** Interface language. Defaults to English so existing callers stay stable. */
  language?: ReplyLanguage
}

type ClarificationPayload = {
  kind: 'pick_conversation' | 'pick_range'
  conversationQuery: string
  candidateIds: string[]
  conversationId: string | null
  range: InterpretOutput['range']
  lastNDays: number | null
  lastNHours: number | null
  isoFrom: string | null
  isoTo: string | null
  focus: string | null
  userText: string
}

/**
 * Converts a model-chosen relative or ISO range into absolute instants
 * using the given timezone. Does not call the LLM.
 */
export function rangeToInterval(
  spec: RangeSpec,
  now: Date,
  timezone: string,
): { from: Date; to: Date } {
  const zonedNow = Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(
    timezone,
  )

  switch (spec.range) {
    case 'today': {
      const from = zonedNow.startOfDay()
      return { from: zonedToDate(from), to: now }
    }
    case 'yesterday': {
      const startToday = zonedNow.startOfDay()
      const startYesterday = startToday.subtract({ days: 1 })
      return { from: zonedToDate(startYesterday), to: zonedToDate(startToday) }
    }
    case 'this_week': {
      const startToday = zonedNow.startOfDay()
      const monday = startToday.subtract({ days: zonedNow.dayOfWeek - 1 })
      return { from: zonedToDate(monday), to: now }
    }
    case 'last_n_days': {
      const n = spec.lastNDays
      if (n === null || n === undefined) {
        throw new Error('last_n_days requires lastNDays')
      }
      const from = zonedNow.subtract({ hours: n * 24 })
      return { from: zonedToDate(from), to: now }
    }
    case 'last_n_hours': {
      const n = spec.lastNHours
      if (n === null || n === undefined) {
        throw new Error('last_n_hours requires lastNHours')
      }
      const from = zonedNow.subtract({ hours: n })
      return { from: zonedToDate(from), to: now }
    }
    case 'iso': {
      if (!spec.isoFrom || !spec.isoTo) {
        throw new Error('iso range requires isoFrom and isoTo')
      }
      return {
        from: parseInTimezone(spec.isoFrom, timezone),
        to: parseInTimezone(spec.isoTo, timezone),
      }
    }
  }
}

function zonedToDate(zdt: Temporal.ZonedDateTime): Date {
  return new Date(zdt.epochMilliseconds)
}

function parseInTimezone(value: string, timezone: string): Date {
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(value)) {
    return new Date(Temporal.Instant.from(value).epochMilliseconds)
  }
  const plain = Temporal.PlainDateTime.from(value)
  const zoned = plain.toZonedDateTime(timezone)
  return zonedToDate(zoned)
}

/**
 * Interprets a natural-language control message into a summary request,
 * a clarifying question, or help. Ambiguous conversation matches ask the
 * user; missing ranges ask for a time window instead of guessing.
 */
export async function interpret(input: InterpretInput): Promise<InterpretResult> {
  const pending = await loadActiveClarification(
    input.db,
    input.provider,
    input.controlExternalId,
    input.now,
  )

  if (pending && isCancelClarificationReply(input.text)) {
    await clearClarification(input.db, input.provider, input.controlExternalId)
    return { kind: 'ask', question: cancelled(languageOf(input)) }
  }

  if (pending) {
    const payload = parseClarificationPayload(pending.originalText)
    if (payload?.kind === 'pick_range') {
      const range = tryParseRangeOnly(input.text)
      if (range && payload.conversationId) {
        await clearClarification(input.db, input.provider, input.controlExternalId)
        return buildRequestFromParsed(
          {
            intent: 'summarize',
            conversationQuery: payload.conversationQuery,
            range: range.range,
            lastNDays: range.lastNDays,
            lastNHours: range.lastNHours,
            isoFrom: range.isoFrom,
            isoTo: range.isoTo,
            focus: payload.focus,
          },
          payload.conversationId,
          input.now,
          input.timezone,
          languageOf(input),
        )
      }
      return { kind: 'ask', question: rangeHelp(languageOf(input)) }
    }

    const selection = parseCandidateIndex(input.text)
    if (payload?.kind === 'pick_conversation' && selection !== null) {
      const candidateId = payload.candidateIds[selection - 1]
      if (candidateId) {
        if (!hasRange(payload)) {
          await saveRangeClarification(input, {
            conversationQuery: payload.conversationQuery,
            conversationId: candidateId,
            focus: payload.focus,
          })
          return { kind: 'ask', question: rangeHelp(languageOf(input)) }
        }
        await clearClarification(input.db, input.provider, input.controlExternalId)
        return buildRequestFromParsed(
          {
            intent: 'summarize',
            conversationQuery: payload.conversationQuery,
            range: payload.range,
            lastNDays: payload.lastNDays,
            lastNHours: payload.lastNHours,
            isoFrom: payload.isoFrom,
            isoTo: payload.isoTo,
            focus: payload.focus,
          },
          candidateId,
          input.now,
          input.timezone,
          languageOf(input),
        )
      }
    }
  }

  // Exact control commands must not wait on the LLM (cold Ollama loads can take minutes).
  if (matchControlCommand(input.text) === 'help') {
    return { kind: 'help' }
  }

  const heuristic = tryParseSummarizeIntent(input.text)
  if (heuristic) {
    return settleInterpret(input, heuristic)
  }

  try {
    const parsed = await generateInterpretOutput(input)
    return settleInterpret(input, normalizeParsed(parsed))
  } catch {
    return {
      kind: 'ask',
      question: couldNotUnderstand(languageOf(input)),
    }
  }
}

function normalizeParsed(parsed: InterpretOutput): InterpretOutput {
  return {
    ...parsed,
    lastNHours: parsed.lastNHours ?? null,
  }
}

function languageOf(input: InterpretInput): ReplyLanguage {
  return input.language === 'es' ? 'es' : 'en'
}

function hasRange(parsed: Pick<InterpretOutput, 'range'> | ClarificationPayload): boolean {
  return parsed.range != null
}

async function generateInterpretOutput(input: InterpretInput): Promise<InterpretOutput> {
  const result = await input.llm.generate({
    system: buildSystemPrompt(input.now, input.timezone),
    prompt: input.text,
    schema: InterpretSchema,
    tools: [
      {
        name: 'searchConversations',
        description: 'Search captured conversations by name substring.',
        inputSchema: z.object({ query: z.string().min(1) }),
        execute: async (toolInput) => {
          const query = String(toolInput.query ?? '')
          return searchConversationsByName(input.db, input.provider, query)
        },
      },
    ],
  })

  return InterpretSchema.parse(result.output)
}

async function settleInterpret(
  input: InterpretInput,
  parsed: InterpretOutput,
): Promise<InterpretResult> {
  if (parsed.intent === 'help' || parsed.intent === 'unknown') {
    if (parsed.intent === 'help') return { kind: 'help' }
    return {
      kind: 'ask',
      question: didNotUnderstand(languageOf(input)),
    }
  }

  const query = parsed.conversationQuery?.trim() ?? ''
  if (!query) {
    return {
      kind: 'ask',
      question: whichConversation(languageOf(input)),
    }
  }

  const resolved = await resolveConversation(input.db, input.provider, query, {
    channel: input.channel,
  })

  if (resolved.kind === 'none') {
    return {
      kind: 'ask',
      question: contactNotFound(languageOf(input), query),
    }
  }

  if (resolved.kind === 'ambiguous') {
    const question = formatAmbiguousQuestion(resolved.candidates, languageOf(input))
    const payload: ClarificationPayload = {
      kind: 'pick_conversation',
      conversationQuery: query,
      candidateIds: resolved.candidates.map((candidate) => candidate.id),
      conversationId: null,
      range: parsed.range,
      lastNDays: parsed.lastNDays,
      lastNHours: parsed.lastNHours,
      isoFrom: parsed.isoFrom,
      isoTo: parsed.isoTo,
      focus: parsed.focus,
      userText: input.text,
    }
    await saveClarification(input.db, {
      provider: input.provider,
      conversationExternalId: input.controlExternalId,
      originalText: JSON.stringify(payload),
      question,
      expiresAt: new Date(input.now.getTime() + CLARIFICATION_TTL_MS),
    })
    return { kind: 'ask', question }
  }

  if (!hasRange(parsed)) {
    await saveRangeClarification(input, {
      conversationQuery: query,
      conversationId: resolved.conversationId,
      focus: parsed.focus,
    })
    return { kind: 'ask', question: rangeHelp(languageOf(input)) }
  }

  await clearClarification(input.db, input.provider, input.controlExternalId)
  return buildRequestFromParsed(
    parsed,
    resolved.conversationId,
    input.now,
    input.timezone,
    languageOf(input),
  )
}

async function saveRangeClarification(
  input: InterpretInput,
  args: { conversationQuery: string; conversationId: string; focus: string | null },
): Promise<void> {
  const payload: ClarificationPayload = {
    kind: 'pick_range',
    conversationQuery: args.conversationQuery,
    candidateIds: [],
    conversationId: args.conversationId,
    range: null,
    lastNDays: null,
    lastNHours: null,
    isoFrom: null,
    isoTo: null,
    focus: args.focus,
    userText: input.text,
  }
  await saveClarification(input.db, {
    provider: input.provider,
    conversationExternalId: input.controlExternalId,
    originalText: JSON.stringify(payload),
    question: rangeHelp(languageOf(input)),
    expiresAt: new Date(input.now.getTime() + CLARIFICATION_TTL_MS),
  })
}

function buildRequestFromParsed(
  parsed: InterpretOutput,
  conversationId: string,
  now: Date,
  timezone: string,
  language: ReplyLanguage = 'en',
): InterpretResult {
  const range = parsed.range
  if (!range) {
    return { kind: 'ask', question: rangeHelp(language) }
  }
  const { from, to } = rangeToInterval(
    {
      range,
      lastNDays: parsed.lastNDays,
      lastNHours: parsed.lastNHours,
      isoFrom: parsed.isoFrom,
      isoTo: parsed.isoTo,
    },
    now,
    timezone,
  )
  return {
    kind: 'request',
    request: {
      conversationId,
      from,
      to,
      focus: parsed.focus,
    },
  }
}

function formatAmbiguousQuestion(candidates: ConversationHit[], language: ReplyLanguage): string {
  const lines = candidates.slice(0, 5).map((candidate, index) =>
    formatContactOption(candidate, index, language),
  )
  return whichContact(language, lines)
}

function isCancelClarificationReply(text: string): boolean {
  const trimmed = text.trim().toLowerCase()
  return trimmed === '0' || trimmed === 'cancel' || trimmed === 'cancelar'
}

function parseCandidateIndex(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const n = Number(trimmed)
  return n >= 1 ? n : null
}

function parseClarificationPayload(raw: string): ClarificationPayload | null {
  try {
    const value = JSON.parse(raw) as ClarificationPayload & { kind?: string }
    if (typeof value.conversationQuery !== 'string') return null
    if (!Array.isArray(value.candidateIds)) return null
    const kind =
      value.kind === 'pick_range' || value.kind === 'pick_conversation'
        ? value.kind
        : value.candidateIds.length > 0
          ? 'pick_conversation'
          : 'pick_range'
    return {
      kind,
      conversationQuery: value.conversationQuery,
      candidateIds: value.candidateIds,
      conversationId: value.conversationId ?? null,
      range: value.range ?? null,
      lastNDays: value.lastNDays ?? null,
      lastNHours: value.lastNHours ?? null,
      isoFrom: value.isoFrom ?? null,
      isoTo: value.isoTo ?? null,
      focus: value.focus ?? null,
      userText: value.userText ?? '',
    }
  } catch {
    return null
  }
}

function buildSystemPrompt(now: Date, timezone: string): string {
  return [
    'You interpret summary requests for a WhatsApp control chat.',
    `Current time: ${now.toISOString()}`,
    `Timezone: ${timezone}`,
    'Choose intent summarize, help, or unknown.',
    'For summarize, set conversationQuery and a range (today, yesterday, this_week, last_n_days, last_n_hours, or iso).',
    'Use last_n_hours with lastNHours for rolling hour windows (e.g. last 2 hours).',
    'Use last_n_days with lastNDays for rolling day windows.',
    'If the user did not specify a time range, set range to null (do not invent today).',
    'Do not invent absolute dates yourself; use range fields. Use searchConversations when the chat name is unclear.',
  ].join('\n')
}
