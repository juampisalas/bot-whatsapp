import type { MessagingProvider } from '../../domain/provider.ts'
import type { Db } from '../../store/client.ts'
import { findValidChunk, upsertChunk } from '../../store/repositories/chunks.ts'
import { listDerivationsByAttachmentIds } from '../../store/repositories/derivations.ts'
import { listMessagesInRange } from '../../store/repositories/message-range.ts'
import { splitIntoDayBuckets } from '../buckets.ts'
import type { SummaryRequest } from '../interpret.ts'
import type { Embedder } from '../llm/embedder.ts'
import type { Llm } from '../llm/port.ts'
import { enrichRange } from '../media/enrich.ts'
import type { MediaModel } from '../media/port.ts'
import type { ResolvedPreferences } from '../preferences.ts'
import { searchByTopic } from '../search.ts'
import { DEFAULT_TRANSCRIPT_BUDGET_CHARS, renderTranscript } from '../transcript.ts'
import {
  SUMMARY_PROMPT_VERSION,
  buildComboSystemPrompt,
  buildComboUserPrompt,
  buildPartialSystemPrompt,
  buildPartialUserPrompt,
} from './prompt.ts'

export const EMPTY_RANGE_SUMMARY = 'No messages in that period.'

export type SummarizeInput = {
  db: Db
  llm: Llm
  request: SummaryRequest
  preferences: ResolvedPreferences
  /** Required when `request.focus` is set (topic search). */
  embedder?: Embedder
  /** When both are set, each day bucket is enriched before rendering. */
  provider?: MessagingProvider
  media?: MediaModel
}

/**
 * Hierarchical day-bucket summary: cache valid daily partials, generate
 * missing ones, then combine when more than one day has content. Combo
 * results are never cached. When `request.focus` is set, each day is
 * filtered via `searchByTopic` and partials are not cached.
 */
export async function summarize(input: SummarizeInput): Promise<string> {
  const { db, llm, request, preferences, embedder, provider, media } = input
  const focus = request.focus
  if (focus != null && embedder == null) {
    throw new Error('embedder is required when request.focus is set')
  }

  const buckets = splitIntoDayBuckets(request.from, request.to, preferences.timezone)

  const partials: Array<{ day: string; text: string }> = []

  for (const bucket of buckets) {
    const key = {
      conversationId: request.conversationId,
      day: bucket.day,
      from: bucket.from,
      to: bucket.to,
      model: llm.model,
      promptVersion: SUMMARY_PROMPT_VERSION,
    }

    if (focus == null) {
      const cached = await findValidChunk(db, key)
      if (cached !== null) {
        partials.push({ day: bucket.day, text: cached })
        continue
      }
    }

    let rangeMessages
    let rangeAttachments
    let messageCount: number
    let lastMessageAt: Date | null

    if (focus != null && embedder != null) {
      const focused = await searchByTopic(
        db,
        embedder,
        request.conversationId,
        bucket.from,
        bucket.to,
        focus,
      )
      if (focused.length === 0) continue

      const loaded = await listMessagesInRange(
        db,
        request.conversationId,
        bucket.from,
        bucket.to,
      )
      const focusedIds = new Set(focused.map((message) => message.id))
      rangeMessages = focused
      rangeAttachments = loaded.attachments.filter((attachment) =>
        focusedIds.has(attachment.messageId),
      )
      messageCount = focused.length
      lastMessageAt = focused[focused.length - 1]!.sentAt
    } else {
      const loaded = await listMessagesInRange(
        db,
        request.conversationId,
        bucket.from,
        bucket.to,
      )
      if (loaded.messageCount === 0 || loaded.lastMessageAt == null) {
        continue
      }
      rangeMessages = loaded.messages
      rangeAttachments = loaded.attachments
      messageCount = loaded.messageCount
      lastMessageAt = loaded.lastMessageAt
    }

    let derivations = new Map<string, string>()
    if (provider && media) {
      await enrichRange(db, provider, media, request.conversationId, bucket.from, bucket.to)
      derivations = await listDerivationsByAttachmentIds(
        db,
        rangeAttachments.map((attachment) => attachment.id),
        {
          transcript: media.transcriptModel,
          description: media.describeModel,
        },
      )
    }

    const transcript = renderTranscript(
      rangeMessages,
      rangeAttachments,
      DEFAULT_TRANSCRIPT_BUDGET_CHARS,
      derivations,
    )
    try {
      const result = await llm.generate({
        system: buildPartialSystemPrompt(preferences, focus),
        prompt: buildPartialUserPrompt(bucket.day, transcript),
      })
      if (focus == null) {
        await upsertChunk(db, key, result.text, messageCount, lastMessageAt!)
      }
      partials.push({ day: bucket.day, text: result.text })
    } catch {
      partials.push({ day: bucket.day, text: failedDayPlaceholder(bucket.day) })
    }
  }

  if (partials.length === 0) return EMPTY_RANGE_SUMMARY
  if (partials.length === 1) return partials[0]!.text

  const combo = await llm.generate({
    system: buildComboSystemPrompt(preferences, focus),
    prompt: buildComboUserPrompt(partials),
  })
  return combo.text
}

export function failedDayPlaceholder(day: string): string {
  return `[could not summarize ${day}]`
}
