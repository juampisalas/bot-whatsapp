import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolveConversation } from '../../src/agent/resolve-conversation.ts'
import {
  searchConversationsByName,
  syncAddressBookName,
  syncPushName,
  upsertConversation,
  upsertParticipant,
} from '../../src/store/repositories/conversations.ts'
import { insertMessage } from '../../src/store/repositories/messages.ts'
import { upsertChatPreferences } from '../../src/store/repositories/preferences.ts'
import { conversations } from '../../src/store/schema.ts'
import { openTestDb, resetTestDb } from '../helpers/db.ts'

const handle = openTestDb()

let grupoFacuId: string
let facuFutbolId: string
let trabajoId: string

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
  trabajoId = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'trabajo',
    kind: 'group',
    name: 'Trabajo',
  })

  await handle.db
    .update(conversations)
    .set({ lastMessageAt: new Date('2026-08-30T10:00:00Z') })
    .where(eq(conversations.id, grupoFacuId))
  await handle.db
    .update(conversations)
    .set({ lastMessageAt: new Date('2026-08-30T12:00:00Z') })
    .where(eq(conversations.id, facuFutbolId))
  await handle.db
    .update(conversations)
    .set({ lastMessageAt: new Date('2026-08-29T09:00:00Z') })
    .where(eq(conversations.id, trabajoId))

  await upsertChatPreferences(handle.db, grupoFacuId, { alias: 'la facu' })
})

afterAll(async () => {
  await resetTestDb(handle.sql)
  await handle.close()
})

test('alias la facu resolves to Grupo Facu', async () => {
  const result = await resolveConversation(handle.db, 'fake', 'la facu')
  expect(result).toEqual({ kind: 'resolved', conversationId: grupoFacuId })
})

test('alias match is case-insensitive', async () => {
  const result = await resolveConversation(handle.db, 'fake', 'La Facu')
  expect(result).toEqual({ kind: 'resolved', conversationId: grupoFacuId })
})

test('query facu is ambiguous between Grupo Facu and Facu fútbol', async () => {
  const result = await resolveConversation(handle.db, 'fake', 'facu')
  expect(result.kind).toBe('ambiguous')
  if (result.kind !== 'ambiguous') return
  expect(result.candidates).toHaveLength(2)
  expect(result.candidates.map((c) => c.id).sort()).toEqual(
    [grupoFacuId, facuFutbolId].sort(),
  )
  // More recent activity first.
  expect(result.candidates[0]?.id).toBe(facuFutbolId)
})

test('query trabajo resolves to a single conversation', async () => {
  const result = await resolveConversation(handle.db, 'fake', 'trabajo')
  expect(result).toEqual({ kind: 'resolved', conversationId: trabajoId })
})

test('query zzz finds nothing', async () => {
  const result = await resolveConversation(handle.db, 'fake', 'zzz')
  expect(result).toEqual({ kind: 'none' })
})

test('query matches participant address-book name on a dm', async () => {
  const marianoId = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'mariano-dm',
    kind: 'dm',
    name: null,
  })
  await syncAddressBookName(handle.db, 'fake', {
    externalIds: ['mariano-dm'],
    name: 'Mariano Mangialavori',
  })

  const result = await resolveConversation(handle.db, 'fake', 'Mariano Mangialavori')
  expect(result).toEqual({ kind: 'resolved', conversationId: marianoId })
})

test('fuzzy query resolves when only one similar chat exists', async () => {
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

  const result = await resolveConversation(handle.db, 'fake', 'Mariano Mangialavori')
  expect(result).toEqual({ kind: 'resolved', conversationId: marianId })
})

test('multi-word query matches saved address-book name on conversation', async () => {
  const marianoId = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: '28106349916326@lid',
    kind: 'dm',
    name: null,
  })
  await syncAddressBookName(handle.db, 'fake', {
    externalIds: ['28106349916326@lid', '5491149800824@s.whatsapp.net'],
    name: 'Mariano Mangialavori',
  })

  const hits = await searchConversationsByName(handle.db, 'fake', 'Mariano Mangialavori')
  expect(hits.map((hit) => hit.id)).toContain(marianoId)

  const result = await resolveConversation(handle.db, 'fake', 'Mariano Mangialavori')
  expect(result).toEqual({ kind: 'resolved', conversationId: marianoId })
})

test('exact saved name resolves even when a group shares the same participant tokens', async () => {
  const marianoId = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: '28106349916326@lid',
    kind: 'dm',
    name: null,
  })
  await syncAddressBookName(handle.db, 'fake', {
    externalIds: ['28106349916326@lid'],
    name: 'Mariano Mangialavori',
  })

  const padelId = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: '120363430912191194@g.us',
    kind: 'group',
    name: 'Padel Nordeltus',
  })
  const participantId = await upsertParticipant(handle.db, {
    provider: 'fake',
    externalId: 'mariano-in-padel',
    displayName: 'Mariano Mangialavori',
  })
  await insertMessage(handle.db, {
    provider: 'fake',
    externalId: 'padel-msg-1',
    conversationId: padelId,
    participantId,
    sentAt: new Date('2026-08-31T16:50:30Z'),
    fromSelf: false,
    text: 'hola',
    subject: null,
    threadExternalId: null,
    replyToExternalId: null,
    raw: null,
  })

  const result = await resolveConversation(handle.db, 'fake', 'Mariano Mangialavori')
  expect(result).toEqual({ kind: 'resolved', conversationId: marianoId })
})
