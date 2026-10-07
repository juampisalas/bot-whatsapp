import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import {
  applySetChatNameCommand,
  parseSetChatNameCommand,
} from '../../src/control/set-chat-name.ts'
import { resolveConversation } from '../../src/agent/resolve-conversation.ts'
import { upsertConversation, syncPushName } from '../../src/store/repositories/conversations.ts'
import { openTestDb, resetTestDb } from '../helpers/db.ts'

const handle = openTestDb()

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

test('parseSetChatNameCommand accepts English and Spanish forms', () => {
  expect(parseSetChatNameCommand('name Mariano Mangialavori for Marian')).toEqual({
    displayName: 'Mariano Mangialavori',
    targetQuery: 'Marian',
  })
  expect(parseSetChatNameCommand('nombre Mariano Mangialavori para Marian')).toEqual({
    displayName: 'Mariano Mangialavori',
    targetQuery: 'Marian',
  })
})

test('applySetChatNameCommand saves address-book name and alias', async () => {
  const marianId = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'marian-dm',
    kind: 'dm',
    name: null,
  })
  await syncPushName(handle.db, 'fake', {
    externalIds: ['marian-dm'],
    name: 'Marian',
  })

  const reply = await applySetChatNameCommand(handle.db, 'fake', {
    displayName: 'Mariano Mangialavori',
    targetQuery: 'Marian',
  })
  expect(reply).toContain('Mariano Mangialavori')

  const result = await resolveConversation(handle.db, 'fake', 'Mariano Mangialavori')
  expect(result).toEqual({ kind: 'resolved', conversationId: marianId })
})
