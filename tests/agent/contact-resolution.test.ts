import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { persistContactMeta } from '../../src/capture/directory.ts'
import { resolveConversation } from '../../src/agent/resolve-conversation.ts'
import {
  searchConversationsByName,
  syncAddressBookName,
  syncPushName,
  upsertConversation,
} from '../../src/store/repositories/conversations.ts'
import { insertMessage } from '../../src/store/repositories/messages.ts'
import { FakeProvider } from '../../src/providers/fake/index.ts'
import { conversations } from '../../src/store/schema.ts'
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

test('query Gusma does not fuzzy-match unrelated groups', async () => {
  await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: '5491160060148-1444333560@g.us',
    kind: 'group',
    name: 'Me gusta',
  })
  await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: '5491125337329@s.whatsapp.net',
    kind: 'dm',
    name: null,
  })
  await syncAddressBookName(handle.db, 'fake', {
    externalIds: ['5491125337329@s.whatsapp.net'],
    name: 'Gusma',
  })

  const result = await resolveConversation(handle.db, 'fake', 'Gusma')
  expect(result).toEqual({
    kind: 'resolved',
    conversationId: expect.any(String),
  })
})

test('unnamed Gusma dm does not fuzzy-match empty groups', async () => {
  await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: '5491160060148-1444333560@g.us',
    kind: 'group',
    name: 'Me gusta',
  })
  await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: '5491125337329@s.whatsapp.net',
    kind: 'dm',
    name: null,
  })

  const result = await resolveConversation(handle.db, 'fake', 'Gusma')
  expect(result).toEqual({ kind: 'none' })
})

test('phone number query resolves a dm by external id digits', async () => {
  const id = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: '5491125337329@s.whatsapp.net',
    kind: 'dm',
    name: null,
  })

  const result = await resolveConversation(handle.db, 'fake', '1125337329')
  expect(result).toEqual({ kind: 'resolved', conversationId: id })
})

test('phone number query resolves the lid chat that stores the linked number', async () => {
  await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: '5491125337329@s.whatsapp.net',
    kind: 'dm',
    name: null,
  })
  const lidId = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: '69780501491910@lid',
    kind: 'dm',
    name: null,
  })
  await syncPushName(handle.db, 'fake', {
    externalIds: ['69780501491910@lid'],
    name: 'Agustin',
  })
  await insertMessage(handle.db, {
    provider: 'fake',
    externalId: 'lid-today-1',
    conversationId: lidId,
    participantId: null,
    sentAt: new Date('2026-09-03T21:31:00Z'),
    fromSelf: false,
    text: 'hola',
    subject: null,
    threadExternalId: null,
    replyToExternalId: null,
    raw: {},
  })
  await persistContactMeta(handle.db, 'fake', {
    externalIds: ['5491125337329@s.whatsapp.net', '69780501491910@lid'],
    pushName: 'Agustin',
  })
  await handle.db
    .update(conversations)
    .set({ name: '+5491125337329' })
    .where(eq(conversations.externalId, '5491125337329@s.whatsapp.net'))

  const result = await resolveConversation(handle.db, 'fake', '+54 9 11 2533-7329')
  expect(result).toEqual({ kind: 'resolved', conversationId: lidId })

  const byShortNumber = await resolveConversation(handle.db, 'fake', '1125337329')
  expect(byShortNumber).toEqual({ kind: 'resolved', conversationId: lidId })

  const [lidRow] = await handle.db
    .select({
      phoneNumber: conversations.phoneNumber,
      pushName: conversations.pushName,
      externalId: conversations.externalId,
    })
    .from(conversations)
    .where(eq(conversations.id, lidId))
  expect(lidRow).toEqual({
    phoneNumber: '5491125337329',
    pushName: 'Agustin',
    externalId: '69780501491910@lid',
  })
})

test('sync-on-miss loads contacts from the channel adapter', async () => {
  const channel = new FakeProvider()
  channel.directoryContacts.push({
    externalIds: ['5491999888777@s.whatsapp.net'],
    addressBookName: 'Gusma',
  })

  const result = await resolveConversation(handle.db, 'fake', 'Gusma', { channel })
  expect(channel.syncDirectoryCalls).toBe(1)
  expect(result.kind).toBe('resolved')

  const hits = await searchConversationsByName(handle.db, 'fake', 'Gusma')
  expect(hits).toHaveLength(1)
  expect(hits[0]?.name).toBe('Gusma')
})

test('push name is searchable when address book name is missing', async () => {
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

  const result = await resolveConversation(handle.db, 'fake', 'Marian')
  expect(result).toEqual({ kind: 'resolved', conversationId: marianId })
})

test('partial contact matches return disambiguation options', async () => {
  await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: '5491125337329@s.whatsapp.net',
    kind: 'dm',
    name: null,
  })
  await syncAddressBookName(handle.db, 'fake', {
    externalIds: ['5491125337329@s.whatsapp.net'],
    name: 'Gusma',
  })
  await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: '5491100000000@s.whatsapp.net',
    kind: 'dm',
    name: null,
  })
  await syncAddressBookName(handle.db, 'fake', {
    externalIds: ['5491100000000@s.whatsapp.net'],
    name: 'Gustavo',
  })

  const result = await resolveConversation(handle.db, 'fake', 'Gus')
  expect(result.kind).toBe('ambiguous')
  if (result.kind === 'ambiguous') {
    expect(result.candidates.length).toBeGreaterThan(1)
  }
})

test('sync-on-miss creates conversation rows for synced contacts', async () => {
  const channel = new FakeProvider()
  channel.directoryContacts.push({
    externalIds: ['5491125337329@s.whatsapp.net'],
    addressBookName: 'Gusma',
  })

  await resolveConversation(handle.db, 'fake', 'Gusma', { channel })

  const rows = await handle.db
    .select({ name: conversations.name, externalId: conversations.externalId })
    .from(conversations)
    .where(eq(conversations.externalId, '5491125337329@s.whatsapp.net'))
  expect(rows[0]?.name).toBe('Gusma')
})
