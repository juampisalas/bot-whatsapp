import { afterAll, beforeAll, expect, test } from 'bun:test'
import { outboundMessages } from '../../src/store/schema.ts'
import {
  claimDueOutbound,
  enqueueOutbound,
  markOutboundFailed,
  markOutboundSent,
} from '../../src/store/repositories/outbox.ts'
import { openTestDb, resetTestDb } from '../helpers/db.ts'

const handle = openTestDb()

beforeAll(async () => {
  await resetTestDb(handle.sql)
})

afterAll(async () => {
  await resetTestDb(handle.sql)
  await handle.close()
})

const destination = { provider: 'fake' as const, conversationExternalId: 'ctrl' }

test('claimDueOutbound does not deliver the same row twice', async () => {
  await enqueueOutbound(handle.db, { ...destination, text: '✦ a', idempotencyKey: 'k1' })
  const now = new Date()
  const first = await claimDueOutbound(handle.db, now, 10)
  const second = await claimDueOutbound(handle.db, now, 10)
  expect(first).toHaveLength(1)
  expect(second).toHaveLength(0)
})

test('claimDueOutbound ignores rows that are not due yet', async () => {
  await enqueueOutbound(handle.db, { ...destination, text: '✦ b', idempotencyKey: 'k2' })
  const [claimed] = await claimDueOutbound(handle.db, new Date(), 10)
  await markOutboundFailed(handle.db, claimed!.id, 'socket down', new Date('2026-08-30T12:05:00Z'))
  const tooEarly = await claimDueOutbound(handle.db, new Date('2026-08-30T12:01:00Z'), 10)
  const afterDue = await claimDueOutbound(handle.db, new Date('2026-08-30T12:06:00Z'), 10)
  expect(tooEarly).toHaveLength(0)
  expect(afterDue).toHaveLength(1)
})
test('markOutboundSent sets status sent and the external id', async () => {
  await enqueueOutbound(handle.db, { ...destination, text: '✦ c', idempotencyKey: 'k3' })
  const [claimed] = await claimDueOutbound(handle.db, new Date(), 1)
  await markOutboundSent(handle.db, claimed!.id, 'ext-9')
  const rows = await handle.db.select().from(outboundMessages)
  const row = rows.find((r) => r.id === claimed!.id)
  expect(row?.status).toBe('sent')
  expect(row?.sentExternalId).toBe('ext-9')
})

test('markOutboundFailed with terminal=true does not return to pending', async () => {
  await enqueueOutbound(handle.db, { ...destination, text: '✦ d', idempotencyKey: 'k4' })
  const [claimed] = await claimDueOutbound(handle.db, new Date(), 1)
  await markOutboundFailed(handle.db, claimed!.id, 'illegal destination', new Date(), true)
  const again = await claimDueOutbound(handle.db, new Date('2099-01-01T00:00:00Z'), 10)
  expect(again.find((r) => r.id === claimed!.id)).toBeUndefined()
})

test('enqueueOutbound returns existing id on idempotency conflict', async () => {
  const first = await enqueueOutbound(handle.db, {
    ...destination,
    text: '✦ e',
    idempotencyKey: 'k5',
  })
  const second = await enqueueOutbound(handle.db, {
    ...destination,
    text: '✦ e again',
    idempotencyKey: 'k5',
  })
  expect(second.id).toBe(first.id)
  const rows = await handle.db.select().from(outboundMessages)
  expect(rows.filter((r) => r.idempotencyKey === 'k5')).toHaveLength(1)
})
