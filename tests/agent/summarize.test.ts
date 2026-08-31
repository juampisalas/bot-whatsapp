import { afterAll, beforeAll, expect, test } from 'bun:test'
import { DEFAULT_PREFERENCES, type ResolvedPreferences } from '../../src/agent/preferences.ts'
import { FakeLlm } from '../../src/agent/llm/fake.ts'
import { FakeMediaModel } from '../../src/agent/media/fake.ts'
import {
  EMPTY_RANGE_SUMMARY,
  failedDayPlaceholder,
  summarize,
} from '../../src/agent/summarize/index.ts'
import {
  isComboSystemPrompt,
  isPartialSystemPrompt,
} from '../../src/agent/summarize/prompt.ts'
import { createIngestPipeline } from '../../src/capture/ingest.ts'
import { FakeProvider } from '../../src/providers/fake/index.ts'
import { upsertConversation, upsertParticipant } from '../../src/store/repositories/conversations.ts'
import { insertMessage } from '../../src/store/repositories/messages.ts'
import { attachments, conversations } from '../../src/store/schema.ts'
import { mensaje } from '../helpers/fixtures.ts'
import { openTestDb, resetTestDb } from '../helpers/db.ts'

const handle = openTestDb()

const preferences: ResolvedPreferences = {
  ...DEFAULT_PREFERENCES,
  language: 'en',
  timezone: 'UTC',
}

beforeAll(async () => {
  await resetTestDb(handle.sql)
})

afterAll(async () => {
  await resetTestDb(handle.sql)
  await handle.close()
})

async function seedConversation(): Promise<{ conversationId: string; participantId: string }> {
  const conversationId = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: `sum-${crypto.randomUUID()}`,
    kind: 'group',
    name: 'Summary Test',
  })
  const participantId = await upsertParticipant(handle.db, {
    provider: 'fake',
    externalId: `p-${crypto.randomUUID()}`,
    displayName: 'Ana',
  })
  return { conversationId, participantId }
}

async function addMessage(
  conversationId: string,
  participantId: string,
  sentAt: Date,
  text: string,
): Promise<void> {
  await insertMessage(handle.db, {
    provider: 'fake',
    externalId: `m-${crypto.randomUUID()}`,
    conversationId,
    participantId,
    sentAt,
    fromSelf: false,
    text,
    subject: null,
    threadExternalId: null,
    replyToExternalId: null,
    raw: null,
  })
}

const twoDayRange = {
  from: new Date('2026-08-29T00:00:00.000Z'),
  to: new Date('2026-08-31T00:00:00.000Z'),
}

const oneDayRange = {
  from: new Date('2026-08-30T00:00:00.000Z'),
  to: new Date('2026-08-31T00:00:00.000Z'),
}

test('two days: two partials then combo', async () => {
  const { conversationId, participantId } = await seedConversation()
  await addMessage(conversationId, participantId, new Date('2026-08-29T12:00:00.000Z'), 'day one')
  await addMessage(conversationId, participantId, new Date('2026-08-30T12:00:00.000Z'), 'day two')

  const llm = new FakeLlm()
  llm.enqueue({ text: 'parcial-A' })
  llm.enqueue({ text: 'parcial-B' })
  llm.enqueue({ text: 'combo' })

  const result = await summarize({
    db: handle.db,
    llm,
    request: { conversationId, ...twoDayRange, focus: null },
    preferences,
  })

  expect(result).toBe('combo')
  expect(llm.calls).toHaveLength(3)
  expect(llm.calls.filter((call) => isPartialSystemPrompt(call.system))).toHaveLength(2)
  expect(llm.calls.filter((call) => isComboSystemPrompt(call.system))).toHaveLength(1)
})

test('second request reuses cached partials and only calls combo', async () => {
  const { conversationId, participantId } = await seedConversation()
  await addMessage(conversationId, participantId, new Date('2026-08-29T12:00:00.000Z'), 'day one')
  await addMessage(conversationId, participantId, new Date('2026-08-30T12:00:00.000Z'), 'day two')

  const llm = new FakeLlm()
  llm.enqueue({ text: 'parcial-A' })
  llm.enqueue({ text: 'parcial-B' })
  llm.enqueue({ text: 'combo-1' })
  llm.enqueue({ text: 'combo-2' })

  const request = { conversationId, ...twoDayRange, focus: null }
  await summarize({ db: handle.db, llm, request, preferences })

  const callsBeforeSecond = llm.calls.length
  const result = await summarize({ db: handle.db, llm, request, preferences })

  expect(result).toBe('combo-2')
  const secondPass = llm.calls.slice(callsBeforeSecond)
  expect(secondPass).toHaveLength(1)
  expect(secondPass.filter((call) => isPartialSystemPrompt(call.system))).toHaveLength(0)
  expect(secondPass.filter((call) => isComboSystemPrompt(call.system))).toHaveLength(1)
})

test('new message on day 2 regenerates that partial only', async () => {
  const { conversationId, participantId } = await seedConversation()
  await addMessage(conversationId, participantId, new Date('2026-08-29T12:00:00.000Z'), 'day one')
  await addMessage(conversationId, participantId, new Date('2026-08-30T12:00:00.000Z'), 'day two')

  const llm = new FakeLlm()
  llm.enqueue({ text: 'parcial-A' })
  llm.enqueue({ text: 'parcial-B' })
  llm.enqueue({ text: 'combo-1' })

  const request = { conversationId, ...twoDayRange, focus: null }
  await summarize({ db: handle.db, llm, request, preferences })

  await addMessage(conversationId, participantId, new Date('2026-08-30T18:00:00.000Z'), 'late')

  llm.enqueue({ text: 'parcial-B-new' })
  llm.enqueue({ text: 'combo-2' })

  const callsBefore = llm.calls.length
  const result = await summarize({ db: handle.db, llm, request, preferences })

  expect(result).toBe('combo-2')
  const secondPass = llm.calls.slice(callsBefore)
  expect(secondPass).toHaveLength(2)
  expect(secondPass.filter((call) => isPartialSystemPrompt(call.system))).toHaveLength(1)
  expect(secondPass.filter((call) => isComboSystemPrompt(call.system))).toHaveLength(1)
  expect(secondPass.find((call) => isPartialSystemPrompt(call.system))?.prompt).toContain(
    '2026-08-30',
  )
})

test('failed partial becomes placeholder and combo continues', async () => {
  const { conversationId, participantId } = await seedConversation()
  await addMessage(conversationId, participantId, new Date('2026-08-29T12:00:00.000Z'), 'day one')
  await addMessage(conversationId, participantId, new Date('2026-08-30T12:00:00.000Z'), 'day two')

  const llm = new FakeLlm()
  llm.enqueueError(new Error('boom'))
  llm.enqueue({ text: 'parcial-B' })
  llm.enqueue({ text: 'combo' })

  const result = await summarize({
    db: handle.db,
    llm,
    request: { conversationId, ...twoDayRange, focus: null },
    preferences,
  })

  expect(result).toBe('combo')
  expect(llm.calls).toHaveLength(3)
  const comboCall = llm.calls.find((call) => isComboSystemPrompt(call.system))
  expect(comboCall?.prompt).toContain(failedDayPlaceholder('2026-08-29'))
  expect(comboCall?.prompt).toContain('parcial-B')
})

test('empty range returns fixed text with zero LLM calls', async () => {
  const { conversationId } = await seedConversation()
  const llm = new FakeLlm()

  const result = await summarize({
    db: handle.db,
    llm,
    request: { conversationId, ...twoDayRange, focus: null },
    preferences,
  })

  expect(result).toBe(EMPTY_RANGE_SUMMARY)
  expect(llm.calls).toHaveLength(0)
})

test('enrichRange runs per bucket; second pass uses cached derivation', async () => {
  await resetTestDb(handle.sql)

  const provider = new FakeProvider()
  const media = new FakeMediaModel()
  const pipeline = createIngestPipeline({
    db: handle.db,
    provider,
    policy: { mode: 'all', rules: new Set() },
    bufferMax: 10,
  })
  provider.onMessage(pipeline.handle)
  await provider.connect()
  await provider.inject(
    mensaje({
      externalId: 'sum-audio-1',
      text: null,
      attachments: [
        {
          externalId: 'audio-1',
          kind: 'audio',
          mimeType: 'audio/ogg',
          sizeBytes: 1024,
          durationMs: 45_000,
        },
      ],
      sentAt: new Date('2026-08-30T12:00:00.000Z'),
    }),
  )

  const [conversation] = await handle.db.select({ id: conversations.id }).from(conversations)
  const [attachment] = await handle.db
    .select({ id: attachments.id, localPath: attachments.localPath })
    .from(attachments)
  if (!conversation || !attachment?.localPath) throw new Error('ingest failed')

  media.enqueueTranscript(attachment.localPath, 'see you on Thursday')

  const llm = new FakeLlm()
  llm.enqueue({ text: 'day-summary' })

  const request = { conversationId: conversation.id, ...oneDayRange, focus: null }
  await summarize({
    db: handle.db,
    llm,
    request,
    preferences,
    provider,
    media,
  })

  expect(media.calls).toHaveLength(1)
  const firstPartial = llm.calls.find((call) => isPartialSystemPrompt(call.system))
  expect(firstPartial?.prompt).toContain('[voice note] see you on Thursday')

  await provider.inject(
    mensaje({
      externalId: 'sum-text-late',
      text: 'late note',
      attachments: [],
      sentAt: new Date('2026-08-30T18:00:00.000Z'),
    }),
  )

  llm.enqueue({ text: 'day-summary-2' })
  const callsBefore = media.calls.length
  await summarize({
    db: handle.db,
    llm,
    request,
    preferences,
    provider,
    media,
  })

  expect(media.calls.length - callsBefore).toBe(0)
  const secondPartial = llm.calls.filter((call) => isPartialSystemPrompt(call.system)).at(-1)
  expect(secondPartial?.prompt).toContain('[voice note] see you on Thursday')
})
