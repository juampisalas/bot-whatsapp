import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  clearClarification,
  loadActiveClarification,
  saveClarification,
} from '../../src/store/repositories/clarifications.ts'
import { openTestDb, resetTestDb } from '../helpers/db.ts'

const handle = openTestDb()

beforeAll(async () => {
  await resetTestDb(handle.sql)
})

afterAll(async () => {
  await resetTestDb(handle.sql)
  await handle.close()
})

const control = { provider: 'fake' as const, conversationExternalId: 'ctrl' }

test('saveClarification replaces an existing row for the same control conversation', async () => {
  await saveClarification(handle.db, {
    ...control,
    originalText: 'first request',
    question: 'which one?',
    expiresAt: new Date('2026-09-01T00:00:00Z'),
  })
  await saveClarification(handle.db, {
    ...control,
    originalText: 'second request',
    question: 'pick a number',
    expiresAt: new Date('2026-09-02T00:00:00Z'),
  })

  const active = await loadActiveClarification(
    handle.db,
    control.provider,
    control.conversationExternalId,
    new Date('2026-08-31T12:00:00Z'),
  )
  expect(active?.originalText).toBe('second request')
  expect(active?.question).toBe('pick a number')
})

test('loadActiveClarification returns null when now is past expiresAt', async () => {
  await saveClarification(handle.db, {
    ...control,
    originalText: 'expired',
    question: 'too late?',
    expiresAt: new Date('2026-08-30T00:00:00Z'),
  })
  const active = await loadActiveClarification(
    handle.db,
    control.provider,
    control.conversationExternalId,
    new Date('2026-08-31T00:00:00Z'),
  )
  expect(active).toBeNull()
})

test('clearClarification leaves no active row', async () => {
  await saveClarification(handle.db, {
    ...control,
    originalText: 'to clear',
    question: 'still there?',
    expiresAt: new Date('2026-09-10T00:00:00Z'),
  })
  await clearClarification(handle.db, control.provider, control.conversationExternalId)
  const active = await loadActiveClarification(
    handle.db,
    control.provider,
    control.conversationExternalId,
    new Date('2026-08-31T12:00:00Z'),
  )
  expect(active).toBeNull()
})
