import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { interpret, rangeToInterval } from '../../src/agent/interpret.ts'
import { FakeLlm } from '../../src/agent/llm/fake.ts'
import { loadActiveClarification } from '../../src/store/repositories/clarifications.ts'
import { upsertConversation } from '../../src/store/repositories/conversations.ts'
import { upsertChatPreferences } from '../../src/store/repositories/preferences.ts'
import { conversations } from '../../src/store/schema.ts'
import { openTestDb, resetTestDb } from '../helpers/db.ts'

const TZ = 'America/Argentina/Buenos_Aires'
const NOW = new Date('2026-08-30T18:00:00-03:00')
const CONTROL = { provider: 'fake' as const, conversationExternalId: 'ctrl' }

const handle = openTestDb()

let grupoFacuId: string
let facuFutbolId: string

beforeAll(async () => {
  await resetTestDb(handle.sql)
})

beforeEach(async () => {
  await resetTestDb(handle.sql)

  grupoFacuId = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'grupo-facu',
    kind: 'group',
    name: 'Grupo Facu',
  })
  facuFutbolId = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'facu-futbol',
    kind: 'group',
    name: 'Facu fútbol',
  })

  await handle.db
    .update(conversations)
    .set({ lastMessageAt: new Date('2026-08-30T10:00:00Z') })
    .where(eq(conversations.id, grupoFacuId))
  await handle.db
    .update(conversations)
    .set({ lastMessageAt: new Date('2026-08-30T12:00:00Z') })
    .where(eq(conversations.id, facuFutbolId))

  await upsertChatPreferences(handle.db, grupoFacuId, { alias: 'la facu' })
})

afterAll(async () => {
  await resetTestDb(handle.sql)
  await handle.close()
})

test('rangeToInterval today uses timezone midnight', () => {
  const { from, to } = rangeToInterval(
    { range: 'today', lastNDays: null, isoFrom: null, isoTo: null },
    NOW,
    TZ,
  )
  expect(from.toISOString()).toBe(new Date('2026-08-30T00:00:00-03:00').toISOString())
  expect(to.toISOString()).toBe(NOW.toISOString())
})

test('rangeToInterval yesterday is the previous calendar day', () => {
  const { from, to } = rangeToInterval(
    { range: 'yesterday', lastNDays: null, isoFrom: null, isoTo: null },
    NOW,
    TZ,
  )
  expect(from.toISOString()).toBe(new Date('2026-08-29T00:00:00-03:00').toISOString())
  expect(to.toISOString()).toBe(new Date('2026-08-30T00:00:00-03:00').toISOString())
})

test('rangeToInterval this_week starts Monday 00:00 in timezone', () => {
  const { from, to } = rangeToInterval(
    { range: 'this_week', lastNDays: null, isoFrom: null, isoTo: null },
    NOW,
    TZ,
  )
  expect(from.toISOString()).toBe(new Date('2026-08-24T00:00:00-03:00').toISOString())
  expect(to.toISOString()).toBe(NOW.toISOString())
})

test('rangeToInterval last_n_days is rolling hours from now', () => {
  const { from, to } = rangeToInterval(
    { range: 'last_n_days', lastNDays: 7, isoFrom: null, isoTo: null },
    NOW,
    TZ,
  )
  expect(from.toISOString()).toBe(new Date('2026-08-23T18:00:00-03:00').toISOString())
  expect(to.toISOString()).toBe(NOW.toISOString())
})

test('rangeToInterval iso parses local datetimes in timezone', () => {
  const { from, to } = rangeToInterval(
    {
      range: 'iso',
      lastNDays: null,
      isoFrom: '2026-08-29T09:00:00',
      isoTo: '2026-08-30T12:30:00',
    },
    NOW,
    TZ,
  )
  expect(from.toISOString()).toBe(new Date('2026-08-29T09:00:00-03:00').toISOString())
  expect(to.toISOString()).toBe(new Date('2026-08-30T12:30:00-03:00').toISOString())
})

function summarizeOutput(overrides: Record<string, unknown> = {}) {
  return {
    intent: 'summarize',
    conversationQuery: 'la facu',
    range: 'today',
    lastNDays: null,
    isoFrom: null,
    isoTo: null,
    focus: null,
    ...overrides,
  }
}

test('1: summarize with alias query resolves to request', async () => {
  const llm = new FakeLlm()
  llm.enqueue({ text: '', output: summarizeOutput() })

  const result = await interpret({
    db: handle.db,
    llm,
    provider: CONTROL.provider,
    controlExternalId: CONTROL.conversationExternalId,
    text: 'summarize la facu today',
    now: NOW,
    timezone: TZ,
  })

  expect(result).toEqual({
    kind: 'request',
    request: {
      conversationId: grupoFacuId,
      from: new Date('2026-08-30T00:00:00-03:00'),
      to: NOW,
      focus: null,
    },
  })
})

test('2: ambiguous query asks and saves clarification', async () => {
  const llm = new FakeLlm()
  llm.enqueue({ text: '', output: summarizeOutput({ conversationQuery: 'facu' }) })

  const result = await interpret({
    db: handle.db,
    llm,
    provider: CONTROL.provider,
    controlExternalId: CONTROL.conversationExternalId,
    text: 'summarize facu',
    now: NOW,
    timezone: TZ,
  })

  expect(result.kind).toBe('ask')
  if (result.kind !== 'ask') return
  expect(result.question).toMatch(/Facu fútbol/i)
  expect(result.question).toMatch(/Grupo Facu/i)

  const pending = await loadActiveClarification(
    handle.db,
    CONTROL.provider,
    CONTROL.conversationExternalId,
    NOW,
  )
  expect(pending).not.toBeNull()
  expect(pending!.expiresAt.getTime()).toBe(NOW.getTime() + 10 * 60 * 1000)
})

test('3: follow-up picks candidate 1 and clears clarification', async () => {
  const llm = new FakeLlm()
  llm.enqueue({ text: '', output: summarizeOutput({ conversationQuery: 'facu' }) })
  await interpret({
    db: handle.db,
    llm,
    provider: CONTROL.provider,
    controlExternalId: CONTROL.conversationExternalId,
    text: 'summarize facu',
    now: NOW,
    timezone: TZ,
  })

  const llm2 = new FakeLlm()
  const result = await interpret({
    db: handle.db,
    llm: llm2,
    provider: CONTROL.provider,
    controlExternalId: CONTROL.conversationExternalId,
    text: '1',
    now: NOW,
    timezone: TZ,
  })

  expect(result).toEqual({
    kind: 'request',
    request: {
      conversationId: facuFutbolId,
      from: new Date('2026-08-30T00:00:00-03:00'),
      to: NOW,
      focus: null,
    },
  })
  expect(llm2.calls).toHaveLength(0)

  const pending = await loadActiveClarification(
    handle.db,
    CONTROL.provider,
    CONTROL.conversationExternalId,
    NOW,
  )
  expect(pending).toBeNull()
})

test('4: expired clarification is ignored and message is interpreted fresh', async () => {
  const llm = new FakeLlm()
  llm.enqueue({ text: '', output: summarizeOutput({ conversationQuery: 'facu' }) })
  await interpret({
    db: handle.db,
    llm,
    provider: CONTROL.provider,
    controlExternalId: CONTROL.conversationExternalId,
    text: 'summarize facu',
    now: NOW,
    timezone: TZ,
  })

  const later = new Date(NOW.getTime() + 11 * 60 * 1000)
  const llm2 = new FakeLlm()
  llm2.enqueue({ text: '', output: summarizeOutput({ conversationQuery: 'la facu' }) })

  const result = await interpret({
    db: handle.db,
    llm: llm2,
    provider: CONTROL.provider,
    controlExternalId: CONTROL.conversationExternalId,
    text: '1',
    now: later,
    timezone: TZ,
  })

  expect(result.kind).toBe('request')
  if (result.kind !== 'request') return
  expect(result.request.conversationId).toBe(grupoFacuId)
  expect(llm2.calls).toHaveLength(1)
})

test('5: help intent returns help', async () => {
  const llm = new FakeLlm()
  llm.enqueue({
    text: '',
    output: {
      intent: 'help',
      conversationQuery: null,
      range: null,
      lastNDays: null,
      isoFrom: null,
      isoTo: null,
      focus: null,
    },
  })

  const result = await interpret({
    db: handle.db,
    llm,
    provider: CONTROL.provider,
    controlExternalId: CONTROL.conversationExternalId,
    text: 'help',
    now: NOW,
    timezone: TZ,
  })

  expect(result).toEqual({ kind: 'help' })
})

test('6: resolve none returns ask, not an empty request', async () => {
  const llm = new FakeLlm()
  llm.enqueue({ text: '', output: summarizeOutput({ conversationQuery: 'zzz' }) })

  const result = await interpret({
    db: handle.db,
    llm,
    provider: CONTROL.provider,
    controlExternalId: CONTROL.conversationExternalId,
    text: 'summarize zzz',
    now: NOW,
    timezone: TZ,
  })

  expect(result.kind).toBe('ask')
  if (result.kind !== 'ask') return
  expect(result.question.length).toBeGreaterThan(0)
})

test('7: FakeLlm generate errors propagate', async () => {
  const llm = new FakeLlm()
  // empty queue → generate throws

  await expect(
    interpret({
      db: handle.db,
      llm,
      provider: CONTROL.provider,
      controlExternalId: CONTROL.conversationExternalId,
      text: 'summarize la facu',
      now: NOW,
      timezone: TZ,
    }),
  ).rejects.toThrow(/no queued responses/i)
})

test('interpret wires searchConversations tool to the llm', async () => {
  const llm = new FakeLlm()
  llm.enqueue({
    text: '',
    output: summarizeOutput(),
    toolsToCall: [{ name: 'searchConversations', input: { query: 'facu' } }],
  })

  await interpret({
    db: handle.db,
    llm,
    provider: CONTROL.provider,
    controlExternalId: CONTROL.conversationExternalId,
    text: 'summarize la facu',
    now: NOW,
    timezone: TZ,
  })

  expect(llm.calls[0]?.tools?.some((t) => t.name === 'searchConversations')).toBe(true)
})
