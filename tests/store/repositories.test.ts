import { test, expect, beforeAll, afterAll } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createDb } from '../../src/store/client.ts'
import { runMigrations } from '../../src/store/migrate.ts'
import { conversations } from '../../src/store/schema.ts'
import { upsertConversation, upsertParticipant } from '../../src/store/repositories/conversations.ts'
import { countMessagesInConversation, insertMessage } from '../../src/store/repositories/messages.ts'

const url = process.env.DATABASE_URL_TEST ?? 'postgres://bot:bot@localhost:5433/botwhatsapp_test'
const handle = createDb(url)

beforeAll(async () => {
  await runMigrations(url)
  await handle.sql`TRUNCATE conversations, participants, messages, attachments RESTART IDENTITY CASCADE`
})

afterAll(async () => {
  await handle.close()
})

test('upsertConversation devuelve el mismo id al repetir', async () => {
  const primero = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'c1',
    kind: 'group',
    name: 'Grupo Facu',
  })
  const segundo = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'c1',
    kind: 'group',
    name: 'Grupo Facu Renombrado',
  })
  expect(segundo).toBe(primero)
})

test('upsertConversation actualiza el nombre', async () => {
  const id = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'c1',
    kind: 'group',
    name: 'Nombre Final',
  })
  const rows = await handle.db
    .select({ name: conversations.name })
    .from(conversations)
    .where(eq(conversations.id, id))
  expect(rows[0]?.name).toBe('Nombre Final')
})

test('insertMessage no duplica el mismo id externo', async () => {
  const conversationId = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'c2',
    kind: 'dm',
    name: null,
  })
  const participantId = await upsertParticipant(handle.db, {
    provider: 'fake',
    externalId: 'p1',
    displayName: 'Ana',
  })

  const entrada = {
    provider: 'fake' as const,
    externalId: 'm1',
    conversationId,
    participantId,
    sentAt: new Date('2026-08-30T12:00:00Z'),
    fromSelf: false,
    text: 'hola',
    subject: null,
    threadExternalId: null,
    replyToExternalId: null,
    raw: { fake: true },
  }

  const primero = await insertMessage(handle.db, entrada)
  const segundo = await insertMessage(handle.db, entrada)

  expect(primero.inserted).toBe(true)
  expect(segundo.inserted).toBe(false)
  expect(segundo.id).toBe(primero.id)
  expect(await countMessagesInConversation(handle.db, conversationId)).toBe(1)
})

test('insertMessage actualiza lastMessageAt de la conversación', async () => {
  const conversationId = await upsertConversation(handle.db, {
    provider: 'fake',
    externalId: 'c3',
    kind: 'group',
    name: 'Otro',
  })
  await insertMessage(handle.db, {
    provider: 'fake',
    externalId: 'm2',
    conversationId,
    participantId: null,
    sentAt: new Date('2026-08-30T15:00:00Z'),
    fromSelf: true,
    text: 'mío',
    subject: null,
    threadExternalId: null,
    replyToExternalId: null,
    raw: null,
  })
  const rows = await handle.db
    .select({ lastMessageAt: conversations.lastMessageAt })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
  expect(rows[0]?.lastMessageAt?.toISOString()).toBe('2026-08-30T15:00:00.000Z')
})
