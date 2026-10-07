import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { FakeLlm } from '../../src/agent/llm/fake.ts'
import { createIngestPipeline } from '../../src/capture/ingest.ts'
import { BOT_PREFIX } from '../../src/control/classify.ts'
import { createControlLoop, HELP_REPLY } from '../../src/control/loop.ts'
import { silentLogger } from '../../src/domain/logger.ts'
import { createDispatcher } from '../../src/outbox/dispatcher.ts'
import { FakeProvider } from '../../src/providers/fake/index.ts'
import { upsertGlobalPreferences } from '../../src/store/repositories/preferences.ts'
import { outboundMessages } from '../../src/store/schema.ts'
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

function helpOutput() {
  return {
    intent: 'help' as const,
    conversationQuery: null,
    range: null,
    lastNDays: null,
    lastNHours: null,
    isoFrom: null,
    isoTo: null,
    focus: null,
  }
}

async function assemble(llm: FakeLlm = new FakeLlm()) {
  const provider = new FakeProvider()
  await provider.connect()
  await upsertGlobalPreferences(handle.db, { language: 'en' })
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

  return { provider, dispatcher, llm }
}

function controlRequest(overrides: Parameters<typeof mensaje>[0] = {}) {
  return mensaje({
    fromSelf: true,
    text: 'help',
    conversation: { externalId: CONTROL_ID, kind: 'group', name: 'Control' },
    ...overrides,
  })
}

test('control request help produces one sent reply with BOT_PREFIX to ctrl', async () => {
  const llm = new FakeLlm()
  llm.enqueue({ text: '', output: helpOutput() })
  const { provider, dispatcher } = await assemble(llm)

  await provider.inject(controlRequest())
  const sent = await dispatcher.tick(new Date())

  expect(sent).toBe(1)
  expect(provider.sent).toHaveLength(1)
  expect(provider.sent[0]?.target.externalId).toBe(CONTROL_ID)
  expect(provider.sent[0]?.content.text).toBe(HELP_REPLY)
  expect(provider.sent[0]?.content.text.startsWith(BOT_PREFIX)).toBe(true)
})

test('failNextSend leaves pending then later tick after due delivers', async () => {
  const llm = new FakeLlm()
  llm.enqueue({ text: '', output: helpOutput() })
  const { provider, dispatcher } = await assemble(llm)
  provider.failNextSend(new Error('socket down'))

  await provider.inject(controlRequest({ externalId: 'm-retry' }))
  expect(await dispatcher.tick(new Date())).toBe(0)
  expect(provider.sent).toHaveLength(0)

  const rows = await handle.db.select().from(outboundMessages)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.status).toBe('pending')

  const delivered = await dispatcher.tick(new Date(Date.now() + 60_000))
  expect(delivered).toBe(1)
  expect(provider.sent).toHaveLength(1)
  expect(provider.sent[0]?.target.externalId).toBe(CONTROL_ID)
})

test('re-injecting bot reply with same externalId does not enqueue a second outbound', async () => {
  const llm = new FakeLlm()
  llm.enqueue({ text: '', output: helpOutput() })
  const { provider, dispatcher } = await assemble(llm)

  await provider.inject(controlRequest({ externalId: 'm-echo' }))
  expect(await dispatcher.tick(new Date())).toBe(1)
  expect(provider.sent).toHaveLength(1)

  const sent = provider.sent[0]!
  await provider.inject(
    controlRequest({
      externalId: sent.idempotencyKey,
      text: sent.content.text,
      fromSelf: true,
    }),
  )

  const rows = await handle.db.select().from(outboundMessages)
  expect(rows).toHaveLength(1)
  expect(await dispatcher.tick(new Date())).toBe(0)
  expect(provider.sent).toHaveLength(1)
})
