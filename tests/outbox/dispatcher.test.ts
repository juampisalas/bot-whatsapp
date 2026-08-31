import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { createDispatcher, nextBackoff } from '../../src/outbox/dispatcher.ts'
import type { Logger } from '../../src/domain/logger.ts'
import { FakeProvider } from '../../src/providers/fake/index.ts'
import { botMessages, outboundMessages } from '../../src/store/schema.ts'
import { enqueueOutbound } from '../../src/store/repositories/outbox.ts'
import { openTestDb, resetTestDb } from '../helpers/db.ts'

const handle = openTestDb()
const CONTROL_ID = 'ctrl'

beforeAll(async () => {
  await resetTestDb(handle.sql)
})

beforeEach(async () => {
  await handle.sql`TRUNCATE outbound_messages, bot_messages RESTART IDENTITY CASCADE`
})

afterAll(async () => {
  await resetTestDb(handle.sql)
  await handle.close()
})

function controlConfig(conversationId: string = CONTROL_ID) {
  return {
    CONTROL_PROVIDER: 'fake' as const,
    CONTROL_CONVERSATION_ID: conversationId,
  }
}

function createLog() {
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = []
  const errors: Array<{ message: string; meta?: Record<string, unknown> }> = []
  const log: Logger = {
    info: () => {},
    warn: (message, meta) => warnings.push({ message, meta }),
    error: (message, meta) => errors.push({ message, meta }),
  }
  return { log, warnings, errors }
}

function createSubject(opts?: { conversationId?: string; log?: Logger; provider?: FakeProvider }) {
  const provider = opts?.provider ?? new FakeProvider()
  const dispatcher = createDispatcher({
    db: handle.db,
    provider,
    config: controlConfig(opts?.conversationId),
    log: opts?.log ?? { info: () => {}, warn: () => {}, error: () => {} },
  })
  return { provider, dispatcher }
}

test('nextBackoff doubles until 60s', () => {
  const first = nextBackoff(1).getTime() - Date.now()
  const second = nextBackoff(2).getTime() - Date.now()
  const capped = nextBackoff(7).getTime() - Date.now()
  expect(first).toBeGreaterThanOrEqual(900)
  expect(first).toBeLessThanOrEqual(1100)
  expect(second).toBeGreaterThanOrEqual(1900)
  expect(second).toBeLessThanOrEqual(2100)
  expect(capped).toBeGreaterThanOrEqual(59_000)
  expect(capped).toBeLessThanOrEqual(61_000)
})

test('pending row + tick sends via provider and records bot message', async () => {
  const { provider, dispatcher } = createSubject()
  await enqueueOutbound(handle.db, {
    provider: 'fake',
    conversationExternalId: CONTROL_ID,
    text: 'hello',
    idempotencyKey: 'idem-ok',
  })

  const sent = await dispatcher.tick()
  expect(sent).toBe(1)
  expect(provider.sent).toHaveLength(1)
  expect(provider.sent[0]?.idempotencyKey).toBe('idem-ok')
  expect(provider.sent[0]?.target).toEqual({ provider: 'fake', externalId: CONTROL_ID })

  const outbound = await handle.db.select().from(outboundMessages)
  expect(outbound).toHaveLength(1)
  expect(outbound[0]?.status).toBe('sent')
  expect(outbound[0]?.sentExternalId).toBe('idem-ok')

  const bots = await handle.db.select().from(botMessages)
  expect(bots).toHaveLength(1)
  expect(bots[0]?.externalId).toBe('idem-ok')
  expect(bots[0]?.outboundId).toBe(outbound[0]?.id)
})

test('send failure returns row to pending with future nextAttemptAt', async () => {
  const { provider, dispatcher } = createSubject()
  provider.failNextSend(new Error('socket down'))
  await enqueueOutbound(handle.db, {
    provider: 'fake',
    conversationExternalId: CONTROL_ID,
    text: 'retry me',
    idempotencyKey: 'idem-fail',
  })

  const before = Date.now()
  const sent = await dispatcher.tick()
  expect(sent).toBe(0)
  expect(provider.sent).toHaveLength(0)

  const rows = await handle.db.select().from(outboundMessages)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.status).toBe('pending')
  expect(rows[0]?.lastError).toBe('socket down')
  expect(rows[0]?.nextAttemptAt.getTime()).toBeGreaterThan(before)
})

test('second tick after due sends the retried row', async () => {
  const { provider, dispatcher } = createSubject()
  provider.failNextSend(new Error('transient'))
  await enqueueOutbound(handle.db, {
    provider: 'fake',
    conversationExternalId: CONTROL_ID,
    text: 'later',
    idempotencyKey: 'idem-retry',
  })

  expect(await dispatcher.tick()).toBe(0)
  expect(provider.sent).toHaveLength(0)

  const sent = await dispatcher.tick(new Date(Date.now() + 60_000))
  expect(sent).toBe(1)
  expect(provider.sent).toHaveLength(1)
  expect(provider.sent[0]?.idempotencyKey).toBe('idem-retry')
})

test('non-control destination does not send and fails terminal', async () => {
  const { log, warnings } = createLog()
  const { provider, dispatcher } = createSubject({ log })
  await enqueueOutbound(handle.db, {
    provider: 'fake',
    conversationExternalId: 'other-chat',
    text: 'leak',
    idempotencyKey: 'idem-bad-dest',
  })

  const sent = await dispatcher.tick()
  expect(sent).toBe(0)
  expect(provider.sent).toHaveLength(0)

  const rows = await handle.db.select().from(outboundMessages)
  expect(rows[0]?.status).toBe('failed')
  expect(rows[0]?.lastError).toContain('destination outside control')
  expect(warnings.length).toBeGreaterThanOrEqual(1)
})

test('tick with no due rows returns 0 and does not send', async () => {
  const { provider, dispatcher } = createSubject()
  const sent = await dispatcher.tick()
  expect(sent).toBe(0)
  expect(provider.sent).toHaveLength(0)
})
