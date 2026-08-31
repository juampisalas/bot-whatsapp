import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  DEFAULT_PREFERENCES,
  getResolvedPreferences,
} from '../../src/agent/preferences.ts'
import { upsertConversation } from '../../src/store/repositories/conversations.ts'
import {
  findConversationIdByAlias,
  upsertChatPreferences,
  upsertGlobalPreferences,
} from '../../src/store/repositories/preferences.ts'
import { openTestDb, resetTestDb } from '../helpers/db.ts'

const handle = openTestDb()

beforeAll(async () => {
  await resetTestDb(handle.sql)
})

afterAll(async () => {
  await resetTestDb(handle.sql)
  await handle.close()
})

test('without rows, getResolvedPreferences returns DEFAULT_PREFERENCES', async () => {
  const resolved = await getResolvedPreferences(handle.db, null)

  expect(resolved).toEqual({
    language: DEFAULT_PREFERENCES.language,
    length: DEFAULT_PREFERENCES.length,
    format: DEFAULT_PREFERENCES.format,
    tone: DEFAULT_PREFERENCES.tone,
    timezone: DEFAULT_PREFERENCES.timezone,
    focus: DEFAULT_PREFERENCES.focus,
    ignoreKinds: [...DEFAULT_PREFERENCES.ignoreKinds],
    alias: DEFAULT_PREFERENCES.alias,
  })
})

test('global language and chat length resolve together', async () => {
  const conversationId = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'prefs-chat-1',
    kind: 'group',
    name: 'Grupo Facu',
  })

  await upsertGlobalPreferences(handle.db, { language: 'en' })
  await upsertChatPreferences(handle.db, conversationId, { length: 'short' })

  const resolved = await getResolvedPreferences(handle.db, conversationId)

  expect(resolved.language).toBe('en')
  expect(resolved.length).toBe('short')
  expect(resolved.format).toBe(DEFAULT_PREFERENCES.format)
  expect(resolved.timezone).toBe(DEFAULT_PREFERENCES.timezone)
})

test('findConversationIdByAlias is case-insensitive', async () => {
  const conversationId = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'prefs-alias-1',
    kind: 'group',
    name: 'Facu',
  })
  await upsertChatPreferences(handle.db, conversationId, { alias: 'la facu' })

  const found = await findConversationIdByAlias(handle.db, 'fake', 'La Facu')
  expect(found).toBe(conversationId)

  const otherProvider = await findConversationIdByAlias(handle.db, 'whatsapp', 'La Facu')
  expect(otherProvider).toBeNull()
})

test('changing preferences.timezone is read on next resolve', async () => {
  await upsertGlobalPreferences(handle.db, { timezone: 'UTC' })

  const resolved = await getResolvedPreferences(handle.db, null)
  expect(resolved.timezone).toBe('UTC')

  await upsertGlobalPreferences(handle.db, { timezone: 'America/Mexico_City' })
  const updated = await getResolvedPreferences(handle.db, null)
  expect(updated.timezone).toBe('America/Mexico_City')
})
