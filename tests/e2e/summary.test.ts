import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { FakeLlm } from '../../src/agent/llm/fake.ts'
import { isPartialSystemPrompt } from '../../src/agent/summarize/prompt.ts'
import { createIngestPipeline } from '../../src/capture/ingest.ts'
import { BOT_PREFIX } from '../../src/control/classify.ts'
import { createControlLoop } from '../../src/control/loop.ts'
import { silentLogger } from '../../src/domain/logger.ts'
import { createDispatcher } from '../../src/outbox/dispatcher.ts'
import { FakeProvider } from '../../src/providers/fake/index.ts'
import { upsertConversation, upsertParticipant } from '../../src/store/repositories/conversations.ts'
import { insertMessage } from '../../src/store/repositories/messages.ts'
import { upsertChatPreferences } from '../../src/store/repositories/preferences.ts'
import { conversations } from '../../src/store/schema.ts'
import { openTestDb, resetTestDb } from '../helpers/db.ts'
import { mensaje } from '../helpers/fixtures.ts'

const handle = openTestDb()
const CONTROL_ID = 'ctrl'
const controlConfig = {
  CONTROL_PROVIDER: 'fake' as const,
  CONTROL_CONVERSATION_ID: CONTROL_ID,
}

beforeAll(async () => {
  await resetTestDb(handle.sql)
})

beforeEach(async () => {
  await resetTestDb(handle.sql)
})

afterAll(async () => {
  await resetTestDb(handle.sql)
  await handle.close()
})

function summarizeOutput(overrides: Record<string, unknown> = {}) {
  return {
    intent: 'summarize',
    conversationQuery: 'la facu',
    range: 'iso',
    lastNDays: null,
    isoFrom: '2026-08-29T00:00:00',
    isoTo: '2026-08-31T00:00:00',
    focus: null,
    ...overrides,
  }
}

async function assemble(llm: FakeLlm) {
  const provider = new FakeProvider()
  await provider.connect()
  const pipeline = createIngestPipeline({
    db: handle.db,
    provider,
    policy: { mode: 'all', rules: new Set() },
    bufferMax: 10,
    log: silentLogger,
  })
  const control = createControlLoop({
    db: handle.db,
    config: controlConfig,
    log: silentLogger,
    llm,
  })
  const dispatcher = createDispatcher({
    db: handle.db,
    provider,
    config: controlConfig,
    log: silentLogger,
  })

  provider.onMessage(async (message) => {
    await pipeline.handle(message)
    await control.handle(message)
  })

  return { provider, dispatcher }
}

function controlRequest(overrides: Parameters<typeof mensaje>[0] = {}) {
  return mensaje({
    fromSelf: true,
    text: 'summarize la facu',
    conversation: { externalId: CONTROL_ID, kind: 'group', name: 'Control' },
    sentAt: new Date('2026-08-30T18:00:00-03:00'),
    ...overrides,
  })
}

async function seedTargetChat(opts?: {
  name?: string
  externalId?: string
  alias?: string | null
  twoDays?: boolean
}): Promise<{ conversationId: string }> {
  const conversationId = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: opts?.externalId ?? `chat-${crypto.randomUUID()}`,
    kind: 'group',
    name: opts?.name ?? 'Grupo Facu',
  })
  await handle.db
    .update(conversations)
    .set({ lastMessageAt: new Date('2026-08-30T12:00:00Z') })
    .where(eq(conversations.id, conversationId))

  if (opts?.alias !== null) {
    await upsertChatPreferences(handle.db, conversationId, {
      alias: opts?.alias ?? 'la facu',
      timezone: 'America/Argentina/Buenos_Aires',
    })
  }

  const participantId = await upsertParticipant(handle.db, {
    provider: 'fake',
    externalId: `p-${crypto.randomUUID()}`,
    displayName: 'Ana',
  })

  if (opts?.twoDays) {
    await insertMessage(handle.db, {
      provider: 'fake',
      externalId: `m-${crypto.randomUUID()}`,
      conversationId,
      participantId,
      sentAt: new Date('2026-08-29T15:00:00-03:00'),
      fromSelf: false,
      text: 'day one note',
      subject: null,
      threadExternalId: null,
      replyToExternalId: null,
      raw: null,
    })
    await insertMessage(handle.db, {
      provider: 'fake',
      externalId: `m-${crypto.randomUUID()}`,
      conversationId,
      participantId,
      sentAt: new Date('2026-08-30T15:00:00-03:00'),
      fromSelf: false,
      text: 'day two note',
      subject: null,
      threadExternalId: null,
      replyToExternalId: null,
      raw: null,
    })
  } else {
    await insertMessage(handle.db, {
      provider: 'fake',
      externalId: `m-${crypto.randomUUID()}`,
      conversationId,
      participantId,
      sentAt: new Date('2026-08-30T12:00:00-03:00'),
      fromSelf: false,
      text: 'hello from facu',
      subject: null,
      threadExternalId: null,
      replyToExternalId: null,
      raw: null,
    })
  }

  return { conversationId }
}

test('1: summary request replies in control with FakeLlm text', async () => {
  await seedTargetChat()
  const llm = new FakeLlm()
  llm.enqueue({ text: '', output: summarizeOutput({ range: 'today', isoFrom: null, isoTo: null }) })
  llm.enqueue({ text: 'facu summary body' })

  const { provider, dispatcher } = await assemble(llm)
  await provider.inject(controlRequest({ externalId: 'sum-1' }))
  expect(await dispatcher.tick(new Date())).toBe(1)

  expect(provider.sent).toHaveLength(1)
  expect(provider.sent[0]?.target.externalId).toBe(CONTROL_ID)
  expect(provider.sent[0]?.content.text).toBe(`${BOT_PREFIX}facu summary body`)
})

test('2: ambiguous ask then number resolves and summarizes', async () => {
  await seedTargetChat({
    name: 'Grupo Facu',
    externalId: 'grupo-facu',
    alias: null,
  })
  await seedTargetChat({
    name: 'Facu fútbol',
    externalId: 'facu-futbol',
    alias: null,
  })

  const llm = new FakeLlm()
  llm.enqueue({
    text: '',
    output: summarizeOutput({
      conversationQuery: 'facu',
      range: 'today',
      isoFrom: null,
      isoTo: null,
    }),
  })
  llm.enqueue({ text: 'picked summary' })

  const { provider, dispatcher } = await assemble(llm)

  await provider.inject(
    controlRequest({
      externalId: 'amb-1',
      text: 'summarize facu',
    }),
  )
  expect(await dispatcher.tick(new Date())).toBe(1)
  expect(provider.sent[0]?.content.text).toStartWith(BOT_PREFIX)
  expect(provider.sent[0]?.content.text).toContain('Which conversation did you mean?')
  expect(provider.sent[0]?.content.text).toContain('1.')
  expect(provider.sent[0]?.content.text).toContain('2.')

  await provider.inject(
    controlRequest({
      externalId: 'amb-2',
      text: '1',
    }),
  )
  expect(await dispatcher.tick(new Date())).toBe(1)
  expect(provider.sent).toHaveLength(2)
  expect(provider.sent[1]?.content.text).toBe(`${BOT_PREFIX}picked summary`)
})

test('3: overlapping second request reuses cached partials', async () => {
  await seedTargetChat({ twoDays: true })
  const llm = new FakeLlm()

  llm.enqueue({ text: '', output: summarizeOutput() })
  llm.enqueue({ text: 'parcial-A' })
  llm.enqueue({ text: 'parcial-B' })
  llm.enqueue({ text: 'combo-1' })

  llm.enqueue({ text: '', output: summarizeOutput() })
  llm.enqueue({ text: 'combo-2' })

  const { provider, dispatcher } = await assemble(llm)

  await provider.inject(controlRequest({ externalId: 'cache-1' }))
  expect(await dispatcher.tick(new Date())).toBe(1)
  expect(provider.sent[0]?.content.text).toBe(`${BOT_PREFIX}combo-1`)

  const partialsAfterFirst = llm.calls.filter((call) => isPartialSystemPrompt(call.system)).length
  expect(partialsAfterFirst).toBe(2)

  await provider.inject(controlRequest({ externalId: 'cache-2' }))
  expect(await dispatcher.tick(new Date())).toBe(1)
  expect(provider.sent[1]?.content.text).toBe(`${BOT_PREFIX}combo-2`)

  const partialsAfterSecond = llm.calls.filter((call) => isPartialSystemPrompt(call.system)).length
  expect(partialsAfterSecond).toBe(2)
})
