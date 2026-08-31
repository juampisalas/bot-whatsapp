import { expect, test } from 'bun:test'
import {
  DEFAULT_TRANSCRIPT_BUDGET_CHARS,
  renderTranscript,
  type TranscriptAttachment,
  type TranscriptMessage,
} from '../../src/agent/transcript.ts'

function msg(
  id: string,
  sentAt: string,
  senderName: string,
  text: string | null,
): TranscriptMessage {
  return { id, sentAt: new Date(sentAt), senderName, text }
}

test('renders text and English attachment markers', () => {
  const messages = [
    msg('m1', '2026-08-30T09:01:00.000Z', 'Ana', 'lets do Thursday'),
    msg('m2', '2026-08-30T09:02:00.000Z', 'Ana', null),
    msg('m3', '2026-08-30T09:03:00.000Z', 'Juan', null),
  ]
  const attachments: TranscriptAttachment[] = [
    { messageId: 'm2', kind: 'audio', durationMs: 45_000 },
    { messageId: 'm3', kind: 'image', durationMs: null },
  ]

  const transcript = renderTranscript(messages, attachments)

  expect(transcript).toBe(
    [
      '[2026-08-30 09:01] Ana: lets do Thursday',
      '[2026-08-30 09:02] Ana: [voice note, 45s]',
      '[2026-08-30 09:03] Juan: [image]',
    ].join('\n'),
  )
})

test('omits middle messages when over budget without splitting lines', () => {
  const messages = [
    msg('a', '2026-08-30T10:00:00.000Z', 'A', 'one'),
    msg('b', '2026-08-30T10:01:00.000Z', 'B', 'two'),
    msg('c', '2026-08-30T10:02:00.000Z', 'C', 'three'),
    msg('d', '2026-08-30T10:03:00.000Z', 'D', 'four'),
    msg('e', '2026-08-30T10:04:00.000Z', 'E', 'five'),
  ]

  const transcript = renderTranscript(messages, [], 90)

  expect(transcript).toContain('[2026-08-30 10:00] A: one')
  expect(transcript).toContain('[2026-08-30 10:04] E: five')
  expect(transcript).toMatch(/… \(\d+ messages omitted\) …/)
  expect(transcript).not.toContain('B: two')
  for (const line of transcript.split('\n')) {
    if (line.startsWith('…')) continue
    expect(line.startsWith('[')).toBe(true)
  }
})

test('default budget is 12000', () => {
  expect(DEFAULT_TRANSCRIPT_BUDGET_CHARS).toBe(12_000)
})
