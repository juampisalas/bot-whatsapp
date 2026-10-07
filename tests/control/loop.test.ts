import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { FakeLlm } from '../../src/agent/llm/fake.ts'
import { BOT_PREFIX } from '../../src/control/classify.ts'
import { createControlLoop, HELP_REPLY } from '../../src/control/loop.ts'
import {
  formatRefreshDoneReply,
  REFRESH_NAMES_STARTED_REPLY,
} from '../../src/control/commands.ts'
import type { Logger } from '../../src/domain/logger.ts'
import { FakeProvider } from '../../src/providers/fake/index.ts'
import { recordBotMessage } from '../../src/store/repositories/bot-messages.ts'
import { upsertGlobalPreferences } from '../../src/store/repositories/preferences.ts'
import { outboundMessages } from '../../src/store/schema.ts'
import { openTestDb, resetTestDb } from '../helpers/db.ts'
import { mensaje } from '../helpers/fixtures.ts'

const handle = openTestDb()
const CONTROL_ID = 'ctrl'

beforeAll(async () => {
  await resetTestDb(handle.sql)
})

beforeEach(async () => {
  await handle.sql`TRUNCATE outbound_messages, bot_messages, pending_clarifications RESTART IDENTITY CASCADE`
})

afterAll(async () => {
  await resetTestDb(handle.sql)
  await handle.close()
})

function controlConfig(conversationId: string | undefined = CONTROL_ID) {
  return {
    CONTROL_PROVIDER: 'fake' as const,
    CONTROL_CONVERSATION_ID: conversationId,
  }
}

function controlMessage(overrides: Parameters<typeof mensaje>[0] = {}) {
  return mensaje({
    fromSelf: true,
    text: 'help',
    conversation: { externalId: CONTROL_ID, kind: 'group', name: 'Control' },
    ...overrides,
  })
}

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

async function setupLoop(opts?: {
  conversationId?: string
  log?: Logger
  llm?: FakeLlm
}): Promise<{ provider: FakeProvider; llm: FakeLlm }> {
  const llm = opts?.llm ?? new FakeLlm()
  if (!opts?.llm) {
    llm.enqueue({ text: '', output: helpOutput() })
  }
  const provider = new FakeProvider()
  await upsertGlobalPreferences(handle.db, { language: 'en' })
  const loop = createControlLoop({
    db: handle.db,
    config: controlConfig(opts?.conversationId),
    log: opts?.log ?? { info: () => {}, warn: () => {}, error: () => {} },
    llm,
    provider,
  })
  provider.onMessage(loop.handle)
  await provider.connect()
  return { provider, llm }
}

test('request in control enqueues one pending outbound with BOT_PREFIX', async () => {
  const { provider } = await setupLoop()
  await provider.inject(controlMessage())

  const rows = await handle.db.select().from(outboundMessages)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.status).toBe('pending')
  expect(rows[0]?.text).toBe(HELP_REPLY)
  expect(rows[0]?.text).toStartWith(BOT_PREFIX)
  expect(rows[0]?.conversationExternalId).toBe(CONTROL_ID)
  expect(provider.sent).toHaveLength(0)
})

test('refresh names command replies when started and when finished', async () => {
  const llm = new FakeLlm()
  const { provider } = await setupLoop({ llm })
  await provider.inject(controlMessage({ text: 'actualizar los nombres de mis chats' }))

  expect(provider.refreshContactNamesCalls).toBe(1)
  expect(llm.calls).toHaveLength(0)

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const rows = await handle.db.select().from(outboundMessages)
    if (rows.length >= 2) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  const rows = await handle.db.select().from(outboundMessages)
  expect(rows.length).toBeGreaterThanOrEqual(2)
  expect(rows[0]?.text).toBe(REFRESH_NAMES_STARTED_REPLY)
  expect(rows[1]?.text).toBe(
    formatRefreshDoneReply({ addressBookNames: 2, pushNames: 0, groupNames: 1, contacts: 2 }),
  )
})

test('first message asks for a language and the choice sticks', async () => {
  await upsertGlobalPreferences(handle.db, { language: null })
  const { provider } = await setupLoop()
  await upsertGlobalPreferences(handle.db, { language: null })
  await provider.inject(controlMessage({ text: 'ayuda', externalId: 'lang-ask' }))

  const asked = await handle.db.select().from(outboundMessages)
  expect(asked).toHaveLength(1)
  expect(asked[0]?.text).toContain('¿Qué idioma preferís?')

  await provider.inject(controlMessage({ text: '1', externalId: 'lang-pick' }))
  const answered = await handle.db.select().from(outboundMessages)
  expect(answered).toHaveLength(2)
  expect(answered[1]?.text).toContain('Pedime un resumen')
})

test('message in other chat enqueues nothing', async () => {
  const { provider } = await setupLoop()
  await provider.inject(mensaje({ fromSelf: true, text: 'help' }))

  const rows = await handle.db.select().from(outboundMessages)
  expect(rows).toHaveLength(0)
})

test('message whose externalId is already in bot_messages enqueues nothing', async () => {
  await recordBotMessage(handle.db, {
    provider: 'fake',
    externalId: 'already-sent',
    outboundId: null,
  })
  const { provider } = await setupLoop()
  await provider.inject(controlMessage({ externalId: 'already-sent' }))

  const rows = await handle.db.select().from(outboundMessages)
  expect(rows).toHaveLength(0)
})

test('text already carrying BOT_PREFIX enqueues nothing', async () => {
  const { provider } = await setupLoop()
  await provider.inject(controlMessage({ text: `${BOT_PREFIX}done` }))

  const rows = await handle.db.select().from(outboundMessages)
  expect(rows).toHaveLength(0)
})

test('empty CONTROL_CONVERSATION_ID enqueues nothing and does not throw', async () => {
  const { provider } = await setupLoop({ conversationId: '' })
  await expect(provider.inject(controlMessage())).resolves.toBeUndefined()

  const rows = await handle.db.select().from(outboundMessages)
  expect(rows).toHaveLength(0)
})

test('LLM failure enqueues error with BOT_PREFIX and calls log.error', async () => {
  const errors: Array<{ message: string; meta?: Record<string, unknown> }> = []
  const log: Logger = {
    info: () => {},
    warn: () => {},
    error: (message, meta) => errors.push({ message, meta }),
  }
  const llm = new FakeLlm()
  llm.enqueueError(new Error('model down'))
  const { provider } = await setupLoop({ log, llm })
  await provider.inject(controlMessage({ text: 'can you summarize Ort for me please' }))

  const rows = await handle.db.select().from(outboundMessages)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.text).toContain('could not understand')
  expect(errors).toHaveLength(0)
})

test('enqueue failure resolves handle and calls log.warn', async () => {
  await handle.sql`
    CREATE OR REPLACE FUNCTION fail_outbound_insert() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'forced enqueue failure';
    END;
    $$ LANGUAGE plpgsql
  `
  await handle.sql`
    CREATE TRIGGER fail_outbound_insert_trigger
    BEFORE INSERT ON outbound_messages
    FOR EACH ROW
    EXECUTE FUNCTION fail_outbound_insert()
  `

  try {
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = []
    const log: Logger = {
      info: () => {},
      warn: (message, meta) => warnings.push({ message, meta }),
      error: () => {},
    }
    const { provider } = await setupLoop({ log })
    await expect(provider.inject(controlMessage())).resolves.toBeUndefined()

    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toBe('control could not enqueue reply')
    expect(warnings[0]?.meta?.externalId).toBe('m1')

    const rows = await handle.db.select().from(outboundMessages)
    expect(rows).toHaveLength(0)
  } finally {
    await handle.sql`DROP TRIGGER IF EXISTS fail_outbound_insert_trigger ON outbound_messages`
    await handle.sql`DROP FUNCTION IF EXISTS fail_outbound_insert()`
  }
})
