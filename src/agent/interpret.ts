import { z } from 'zod'
import type { ProviderId } from '../domain/types.ts'
import type { Db } from '../store/client.ts'
import {
  clearClarification,
  loadActiveClarification,
  saveClarification,
} from '../store/repositories/clarifications.ts'
import { searchConversationsByName } from '../store/repositories/conversations.ts'
import type { Llm } from './llm/port.ts'
import { resolveConversation, type ConversationHit } from './resolve-conversation.ts'

export const CLARIFICATION_TTL_MS = 10 * 60 * 1000

export const InterpretSchema = z.object({
  intent: z.enum(['summarize', 'help', 'unknown']),
  conversationQuery: z.string().nullable(),
  range: z.enum(['today', 'yesterday', 'this_week', 'last_n_days', 'iso']).nullable(),
  lastNDays: z.number().int().positive().nullable(),
  isoFrom: z.string().nullable(),
  isoTo: z.string().nullable(),
  focus: z.string().nullable(),
})

export type InterpretOutput = z.infer<typeof InterpretSchema>

export type RangeSpec = {
  range: NonNullable<InterpretOutput['range']>
  lastNDays: number | null
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
  controlExternalId: string
  text: string
  now: Date
  timezone: string
}

type ClarificationPayload = {
  conversationQuery: string
  range: InterpretOutput['range']
  lastNDays: number | null
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
 * user; LLM errors are not swallowed.
 */
export async function interpret(input: InterpretInput): Promise<InterpretResult> {
  const pending = await loadActiveClarification(
    input.db,
    input.provider,
    input.controlExternalId,
    input.now,
  )

  const selection = parseCandidateIndex(input.text)
  if (pending && selection !== null) {
    const payload = parseClarificationPayload(pending.originalText)
    if (payload) {
      const resolved = await resolveConversation(
        input.db,
        input.provider,
        payload.conversationQuery,
      )
      if (resolved.kind === 'ambiguous') {
        const pick = resolved.candidates[selection - 1]
        if (pick) {
          await clearClarification(input.db, input.provider, input.controlExternalId)
          return buildRequestFromParsed(
            {
              intent: 'summarize',
              conversationQuery: payload.conversationQuery,
              range: payload.range,
              lastNDays: payload.lastNDays,
              isoFrom: payload.isoFrom,
              isoTo: payload.isoTo,
              focus: payload.focus,
            },
            pick.id,
            input.now,
            input.timezone,
          )
        }
      }
    }
  }

  const parsed = await generateInterpretOutput(input)
  return settleInterpret(input, parsed)
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
      question: 'I did not understand that. Ask for a summary of a chat, or say help.',
    }
  }

  const query = parsed.conversationQuery?.trim() ?? ''
  if (!query) {
    return {
      kind: 'ask',
      question: 'Which conversation should I summarize?',
    }
  }

  const resolved = await resolveConversation(input.db, input.provider, query)

  if (resolved.kind === 'none') {
    return {
      kind: 'ask',
      question: `I could not find a conversation matching "${query}". Try another name.`,
    }
  }

  if (resolved.kind === 'ambiguous') {
    const question = formatAmbiguousQuestion(resolved.candidates)
    const payload: ClarificationPayload = {
      conversationQuery: query,
      range: parsed.range,
      lastNDays: parsed.lastNDays,
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

  await clearClarification(input.db, input.provider, input.controlExternalId)
  return buildRequestFromParsed(parsed, resolved.conversationId, input.now, input.timezone)
}

function buildRequestFromParsed(
  parsed: InterpretOutput,
  conversationId: string,
  now: Date,
  timezone: string,
): InterpretResult {
  const range = parsed.range ?? 'today'
  const { from, to } = rangeToInterval(
    {
      range,
      lastNDays: parsed.lastNDays,
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

function formatAmbiguousQuestion(candidates: ConversationHit[]): string {
  const lines = candidates.map((c, i) => {
    const name = c.name ?? '(unnamed)'
    return `${i + 1}. ${name}`
  })
  return `Which conversation did you mean?\n${lines.join('\n')}\nReply with a number.`
}

function parseCandidateIndex(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const n = Number(trimmed)
  return n >= 1 ? n : null
}

function parseClarificationPayload(raw: string): ClarificationPayload | null {
  try {
    const value = JSON.parse(raw) as ClarificationPayload
    if (typeof value.conversationQuery !== 'string') return null
    return value
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
    'For summarize, set conversationQuery and a range (today, yesterday, this_week, last_n_days, or iso).',
    'Do not invent absolute dates yourself; use range fields. Use searchConversations when the chat name is unclear.',
  ].join('\n')
}
