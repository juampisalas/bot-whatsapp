import type { AttachmentKind } from '../domain/types.ts'

export const DEFAULT_TRANSCRIPT_BUDGET_CHARS = 12_000

export type TranscriptMessage = {
  id: string
  sentAt: Date
  senderName: string
  text: string | null
}

export type TranscriptAttachment = {
  id: string
  messageId: string
  kind: AttachmentKind
  durationMs: number | null
}

/**
 * Renders messages as a line-oriented transcript. When the result exceeds
 * `budgetChars`, whole messages in the middle are omitted (never split).
 * Cached transcripts/descriptions are keyed by attachment id in `derivations`.
 */
export function renderTranscript(
  messages: TranscriptMessage[],
  attachments: TranscriptAttachment[],
  budgetChars: number = DEFAULT_TRANSCRIPT_BUDGET_CHARS,
  derivations: ReadonlyMap<string, string> = new Map(),
): string {
  const byMessage = new Map<string, TranscriptAttachment[]>()
  for (const attachment of attachments) {
    const list = byMessage.get(attachment.messageId)
    if (list) list.push(attachment)
    else byMessage.set(attachment.messageId, [attachment])
  }

  const lines = messages.map((message) =>
    formatLine(message, byMessage.get(message.id) ?? [], derivations),
  )
  return fitWithinBudget(lines, budgetChars)
}

function formatLine(
  message: TranscriptMessage,
  messageAttachments: TranscriptAttachment[],
  derivations: ReadonlyMap<string, string>,
): string {
  const stamp = formatTimestamp(message.sentAt)
  const bodyParts: string[] = []
  if (message.text) bodyParts.push(message.text)
  for (const attachment of messageAttachments) {
    bodyParts.push(formatAttachmentMarker(attachment, derivations))
  }
  const body = bodyParts.join(' ')
  return `[${stamp}] ${message.senderName}: ${body}`
}

function formatTimestamp(sentAt: Date): string {
  const zoned = Temporal.Instant.fromEpochMilliseconds(sentAt.getTime()).toZonedDateTimeISO('UTC')
  const y = String(zoned.year).padStart(4, '0')
  const mo = String(zoned.month).padStart(2, '0')
  const d = String(zoned.day).padStart(2, '0')
  const h = String(zoned.hour).padStart(2, '0')
  const mi = String(zoned.minute).padStart(2, '0')
  return `${y}-${mo}-${d} ${h}:${mi}`
}

function formatAttachmentMarker(
  attachment: TranscriptAttachment,
  derivations: ReadonlyMap<string, string>,
): string {
  const derived = derivations.get(attachment.id)
  if (derived != null && derived !== '') {
    if (attachment.kind === 'audio') return `[voice note] ${derived}`
    if (attachment.kind === 'image') return `[image] ${derived}`
  }

  switch (attachment.kind) {
    case 'audio': {
      if (attachment.durationMs == null) return '[voice note]'
      const seconds = Math.round(attachment.durationMs / 1000)
      return `[voice note, ${seconds}s]`
    }
    case 'image':
      return '[image]'
    case 'video': {
      if (attachment.durationMs == null) return '[video]'
      const seconds = Math.round(attachment.durationMs / 1000)
      return `[video, ${seconds}s]`
    }
    case 'document':
      return '[document]'
    case 'sticker':
      return '[sticker]'
  }
}

function fitWithinBudget(lines: string[], budgetChars: number): string {
  const full = lines.join('\n')
  if (full.length <= budgetChars) return full
  if (lines.length === 0) return ''
  if (lines.length === 1) return lines[0]!

  for (let omitCount = 1; omitCount <= lines.length - 2; omitCount++) {
    const keepTotal = lines.length - omitCount
    for (let head = Math.ceil(keepTotal / 2); head >= 1; head--) {
      const tail = keepTotal - head
      if (tail < 1) continue
      const marker = `… (${omitCount} messages omitted) …`
      const candidate = [
        ...lines.slice(0, head),
        marker,
        ...lines.slice(lines.length - tail),
      ].join('\n')
      if (candidate.length <= budgetChars) return candidate
    }
  }

  const marker = `… (${lines.length - 2} messages omitted) …`
  const minimal = [lines[0]!, marker, lines[lines.length - 1]!].join('\n')
  if (minimal.length <= budgetChars) return minimal
  return lines[0]!
}
