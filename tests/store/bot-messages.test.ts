import { afterAll, beforeAll, expect, test } from 'bun:test'
import { isBotMessage, recordBotMessage } from '../../src/store/repositories/bot-messages.ts'
import { openTestDb, resetTestDb } from '../helpers/db.ts'

const handle = openTestDb()

beforeAll(async () => {
  await resetTestDb(handle.sql)
})

afterAll(async () => {
  await resetTestDb(handle.sql)
  await handle.close()
})

test('recordBotMessage makes isBotMessage return true', async () => {
  await recordBotMessage(handle.db, {
    provider: 'fake',
    externalId: 'bot-ext-1',
    outboundId: null,
  })
  expect(await isBotMessage(handle.db, 'fake', 'bot-ext-1')).toBe(true)
})

test('isBotMessage returns false for an unknown id', async () => {
  expect(await isBotMessage(handle.db, 'fake', 'missing-ext')).toBe(false)
})

test('recordBotMessage does not throw on duplicate provider and external id', async () => {
  await recordBotMessage(handle.db, {
    provider: 'fake',
    externalId: 'bot-ext-dup',
    outboundId: null,
  })
  await expect(
    recordBotMessage(handle.db, {
      provider: 'fake',
      externalId: 'bot-ext-dup',
      outboundId: null,
    }),
  ).resolves.toBeUndefined()
  expect(await isBotMessage(handle.db, 'fake', 'bot-ext-dup')).toBe(true)
})
